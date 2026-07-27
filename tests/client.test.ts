import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  Funky,
  type UnknownContentBlock,
  type UnknownSessionEvent,
} from "../src";
import {
  agentJSON,
  environmentJSON,
  eventJSON,
  jsonResponse,
  sessionJSON,
} from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FUNKY_API_KEY;
});

describe("client and resources", () => {
  it("generates one stable ID and retries an identical create body", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return jsonResponse({ error: { message: "try again" } }, { status: 502 });
      }
      const body = JSON.parse(await request.clone().text()) as { id: string };
      return jsonResponse(agentJSON({ id: body.id }), { status: 201 });
    });
    const client = new Funky({
      apiKey: "fk_secret",
      baseURL: "https://example.test",
      fetch,
    });

    const agent = await client.agents.create({
      name: "Research agent",
      system_prompt: "Be careful.",
      model: { provider: "anthropic", model: "claude-sonnet-5" },
    });

    expect(requests).toHaveLength(2);
    expect(await requests[0]?.clone().text()).toEqual(
      await requests[1]?.clone().text(),
    );
    const sent = JSON.parse(await requests[0]!.clone().text()) as { id: string };
    expect(agent.id).toBe(sent.id);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer fk_secret");
    expect(agent.created_at).toBeInstanceOf(Date);
    expect(agent.created_at.toISOString()).toBe("2026-07-24T20:00:00.000Z");
  });

  it.each([200, 201])("accepts %i for idempotent creation", async (status) => {
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async () => jsonResponse(environmentJSON(), { status })),
    });
    const environment = await client.environments.create({ name: "default" });
    expect(environment.id).toBe("environment-1");
  });

  it("sends explicit nulls and rejects empty updates", async () => {
    let sent: unknown;
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return jsonResponse(agentJSON({ runtime: null }));
      }),
    });

    const agent = await client.agents.update("agent-1", {
      description: null,
      runtime: null,
    });
    expect(sent).toEqual({ description: null, runtime: null });
    expect(agent.runtime).toBeNull();
    await expect(client.agents.update("agent-1", {})).rejects.toThrow(
      "At least one agent field",
    );
  });

  it("accepts a 204 environment deletion and does not retry it", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new Funky({ apiKey: "fk_test", fetch });
    await expect(client.environments.delete("environment-1")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries idempotent archive operations", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "try again" } }, { status: 502 }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          agentJSON({ archived_at: "2026-07-24T21:00:00.000Z" }),
        ),
      );
    const client = new Funky({ apiKey: "fk_test", fetch });
    const archived = await client.agents.archive("agent-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(archived.archived_at?.toISOString()).toBe(
      "2026-07-24T21:00:00.000Z",
    );
  });

  it("maps API errors, keeps request metadata, and redacts secrets", async () => {
    const client = new Funky({
      apiKey: "fk_secret",
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid credential fk_leaked",
              code: "expired",
              api_key: "fk_leaked",
            },
            request_id: "request-1",
          },
          { status: 401, headers: { "request-id": "header-request" } },
        ),
      ),
    });

    const error = await client.agents.retrieve("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({
      status_code: 401,
      statusCode: 401,
      error_type: "authentication_error",
      code: "expired",
      request_id: "request-1",
    });
    expect(error.body.error.api_key).toBe("[REDACTED]");
    expect(String(error)).not.toContain("fk_leaked");
    expect(client.toString()).not.toContain("fk_secret");
  });

  it("auto-paginates resources using last_id", async () => {
    const cursors: Array<string | null> = [];
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async (input) => {
        const cursor = new URL(String(input)).searchParams.get("after_id");
        cursors.push(cursor);
        return cursor === null
          ? jsonResponse({
              data: [sessionJSON({ id: "session-2" })],
              has_more: true,
              last_id: "2",
            })
          : jsonResponse({
              data: [sessionJSON({ id: "session-1" })],
              has_more: false,
              last_id: "1",
            });
      }),
    });

    const ids: string[] = [];
    for await (const session of client.sessions.iter()) ids.push(session.id);
    expect(ids).toEqual(["session-2", "session-1"]);
    expect(cursors).toEqual([null, "2"]);
  });

  it("paginates events by the last returned sequence and preserves unknown data", async () => {
    const cursors: Array<string | null> = [];
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async (input) => {
        const cursor = new URL(String(input)).searchParams.get("after_seq");
        cursors.push(cursor);
        return cursor === "0"
          ? jsonResponse({
              data: [
                eventJSON(2, "user_message", {
                  content: [{ type: "image", x: 1 }],
                }),
              ],
              has_more: true,
              last_seq: 10,
            })
          : jsonResponse({
              data: [eventJSON(3, "future_event", { new: "value" })],
              has_more: false,
              last_seq: 10,
            });
      }),
    });

    const events = [];
    for await (const event of client.sessions.iterEvents("session-1")) {
      events.push(event);
    }
    expect(cursors).toEqual(["0", "2"]);
    const block = (events[0] as { payload: { content: UnknownContentBlock[] } })
      .payload.content[0];
    expect(block?.raw.x).toBe(1);
    expect((events[1] as UnknownSessionEvent).raw.payload).toEqual({
      new: "value",
    });
  });

  it("types 202 message responses and never retries a message", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ turn: "queued", seq: 2 }, { status: 202 }),
    );
    const client = new Funky({ apiKey: "fk_test", fetch });
    await expect(
      client.sessions.sendMessage("session-1", { content: "Hello" }),
    ).resolves.toEqual({ turn: "queued", seq: 2 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries response-body disconnects only for safe operations", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const brokenResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket disconnected"));
          },
        }),
      );
    const retrieveFetch = vi
      .fn()
      .mockResolvedValueOnce(brokenResponse())
      .mockResolvedValueOnce(jsonResponse(agentJSON()));
    const retrieveClient = new Funky({
      apiKey: "fk_test",
      fetch: retrieveFetch,
    });
    await expect(retrieveClient.agents.retrieve("agent-1")).resolves.toMatchObject({
      id: "agent-1",
    });
    expect(retrieveFetch).toHaveBeenCalledTimes(2);

    const messageFetch = vi.fn(async () => brokenResponse());
    const messageClient = new Funky({
      apiKey: "fk_test",
      fetch: messageFetch,
    });
    await expect(
      messageClient.sessions.sendMessage("session-1", { content: "Hello" }),
    ).rejects.toBeInstanceOf(APIConnectionError);
    expect(messageFetch).toHaveBeenCalledOnce();
  });

  it("applies the REST timeout while reading the response body", async () => {
    const fetch = vi.fn(async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () =>
                controller.error(
                  new DOMException("The operation was aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        }),
      );
    });
    const client = new Funky({
      apiKey: "fk_test",
      fetch,
      timeoutMs: 1,
      maxRetries: 0,
    });
    await expect(client.health()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("waits for provisioning and supports Python-style method aliases", async () => {
    const statuses = ["provisioning", "ready"];
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async () =>
        jsonResponse(sessionJSON({ status: statuses.shift() })),
      ),
    });
    const session = await client.sessions.wait_until_ready("session-1", {
      timeout: 1,
      poll_interval: 0,
    });
    expect(session.status).toBe("ready");
  });

  it("reads the environment API key and exposes a secret-safe representation", () => {
    process.env.FUNKY_API_KEY = "fk_environment_secret";
    const client = new Funky({ fetch: vi.fn() });
    expect(client.toString()).toBe('Funky(baseURL="https://api.funky.dev")');
    client.close();
  });
});
