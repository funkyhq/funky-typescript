import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Funky,
  NotFoundError,
  TurnFailedError,
  type UnknownContentBlock,
} from "../src";
import { eventJSON, jsonResponse, sse } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("event streaming", () => {
  it("reconnects with Last-Event-ID and defensively deduplicates", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const requests: Request[] = [];
    const first = eventJSON(1, "session_provisioned", {});
    const terminal = eventJSON(2, "turn_completed", {});
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      if (requests.length === 1) {
        let pulls = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode(sse(first)));
              } else {
                controller.error(new TypeError("socket disconnected"));
              }
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(sse(first, terminal), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = new Funky({ apiKey: "fk_test", fetch });

    const yielded = [];
    for await (const event of client.sessions.streamEvents("session-1")) {
      yielded.push(event);
      if (event.type === "turn_completed") break;
    }

    expect(yielded.map((event) => event.seq)).toEqual([1, 2]);
    expect(new URL(requests[0]!.url).searchParams.get("after_seq")).toBe("0");
    expect(requests[1]?.headers.get("last-event-id")).toBe("1");
  });

  it("surfaces an HTTP error before opening", async () => {
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async () =>
        jsonResponse(
          {
            error: { type: "not_found_error", message: "missing" },
            request_id: "req-1",
          },
          { status: 404 },
        ),
      ),
    });

    const consume = async () => {
      for await (const _event of client.sessions.streamEvents("session-1")) {
        // The stream fails before yielding.
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("runTurn manages the stream and collects assistant text", async () => {
    const assistant = eventJSON(3, "assistant_message", {
      content: [
        { type: "text", text: "2026-07-26" },
        { type: "future_block", value: "ignored" },
      ],
      tool_calls: [],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const followUp = eventJSON(4, "assistant_message", {
      content: [{ type: "text", text: "PDT (-0700)" }],
      tool_calls: [],
    });
    const terminal = eventJSON(5, "turn_completed", {});
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return jsonResponse({ turn: "queued", seq: 2 }, { status: 202 });
      }
      return new Response(sse(assistant, followUp, terminal), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = new Funky({ apiKey: "fk_test", fetch });

    const result = await client.sessions.runTurn("session-1", {
      content: "What is today's date?",
    });

    expect(result.output_text).toBe("2026-07-26\nPDT (-0700)");
    expect(result.submission.seq).toBe(2);
    expect(result.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(result.terminal_event.seq).toBe(5);
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/sessions/session-1/messages",
    );
    expect(await requests[0]!.clone().json()).toEqual({
      content: "What is today's date?",
    });
    expect(new URL(requests[1]!.url).searchParams.get("after_seq")).toBe("2");
    const block = (
      result.events[0] as {
        payload: { content: Array<UnknownContentBlock | { type: "text" }> };
      }
    ).payload.content[1] as UnknownContentBlock;
    expect(block.raw.value).toBe("ignored");
  });

  it("runTurn raises a typed turn failure", async () => {
    const failure = eventJSON(3, "turn_failed", {
      error_class: "BUDGET",
      message: "iteration budget exhausted",
    });
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async (_input, init) =>
        init?.method === "POST"
          ? jsonResponse({ turn: "queued", seq: 2 }, { status: 202 })
          : new Response(sse(failure), {
              headers: { "content-type": "text/event-stream" },
            }),
      ),
    });

    const error = await client.sessions
      .runTurn("session-1", { content: "Hello" })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(TurnFailedError);
    expect(error).toMatchObject({
      message: "iteration budget exhausted",
      error_class: "BUDGET",
      session_id: "session-1",
      seq: 3,
    });
  });

  it("closes a hanging response when aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(":hb\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    });
    const controller = new AbortController();
    const consume = async () => {
      for await (const _event of client.sessions.streamEvents("session-1", {
        signal: controller.signal,
      })) {
        // Heartbeats do not yield events.
      }
    };

    const consuming = consume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await consuming;
    expect(cancelled).toBe(true);
  });

  it("closes active streams when the client closes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const client = new Funky({
      apiKey: "fk_test",
      fetch: vi.fn(async () => new Response(body)),
    });
    const consume = async () => {
      for await (const _event of client.sessions.streamEvents("session-1")) {
        // The test closes the client.
      }
    };
    const consuming = consume();
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.close();
    await consuming;
    expect(cancelled).toBe(true);
  });
});
