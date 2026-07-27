export function agentJSON(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    id: "agent-1",
    name: "Research agent",
    description: null,
    metadata: {},
    version: 1,
    system_prompt: "Be careful.",
    model: { provider: "anthropic", model: "claude-sonnet-5" },
    tool_policy: {},
    runtime: { type: "native" },
    created_at: "2026-07-24T20:00:00.000Z",
    updated_at: "2026-07-24T20:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

export function environmentJSON(overrides: Record<string, unknown> = {}) {
  return {
    type: "environment",
    id: "environment-1",
    name: "default",
    description: null,
    metadata: {},
    network: { type: "unrestricted" },
    created_at: "2026-07-24T20:00:00.000Z",
    updated_at: "2026-07-24T20:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

export function sessionJSON(overrides: Record<string, unknown> = {}) {
  return {
    type: "session",
    id: "session-1",
    status: "ready",
    agent: { id: "agent-1", version: 1 },
    environment_id: "environment-1",
    title: null,
    metadata: {},
    created_at: "2026-07-24T20:00:00.000Z",
    updated_at: "2026-07-24T20:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

export function eventJSON(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    type,
    seq,
    session_id: "session-1",
    created_at: "2026-07-24T20:00:03.000Z",
    payload,
  };
}

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function sse(...events: Record<string, unknown>[]): string {
  return events
    .map(
      (event) =>
        `:hb\nid: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}
