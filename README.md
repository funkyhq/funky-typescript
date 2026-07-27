# Funky TypeScript SDK

The TypeScript client for building and running agents with
[Funky](https://funky.dev). It provides typed APIs for agents, environments,
sessions, and session events.

> The SDK is currently an alpha. It covers Funky's `/v1` data-plane API and
> intentionally does not expose organization, project, membership, API-key, or
> other `/console/v1` administration APIs.

## Installation

```sh
npm install funky-sdk
```

Funky supports Node.js 20 and newer.

## Quick start

Set an API key provisioned through Funky:

```sh
export FUNKY_API_KEY=fk_...
```

Then create reusable agent and environment configurations and start a session:

```ts
import { Funky } from "funky-sdk";

const funky = new Funky();

const agent = await funky.agents.create({
  name: "Repository investigator",
  system_prompt: "You are a careful coding agent. Verify claims with tools.",
  model: { provider: "anthropic", model: "claude-sonnet-5" },
  tool_policy: { max_iterations: 20 },
});

const environment = await funky.environments.create({
  name: "github-access",
  network: {
    type: "limited",
    allowed_hosts: ["github.com", "*.githubusercontent.com"],
  },
});

const session = await funky.sessions.create({
  agent: agent.id,
  environment_id: environment.id,
  title: "Investigate issue 42",
});

await funky.sessions.waitUntilReady(session.id);

const result = await funky.sessions.runTurn(session.id, {
  content: "Inspect the repository and identify the root cause.",
});

console.log(result.output_text);
funky.close();
```

Create agents and environments during application setup and retain their IDs.
A new session is appropriate for each independent run or durable conversation.

Public model and parameter fields use the API's `snake_case` spelling. Resource
methods use normal TypeScript camelCase. Python-style aliases such as
`send_message`, `list_events`, and `wait_until_ready` are also available when
sharing examples between Funky SDKs.

## Resource APIs

The client exposes:

```ts
funky.agents.create(...)
funky.agents.list(...)
funky.agents.iter(...)
funky.agents.retrieve(agentId)
funky.agents.update(agentId, ...)
funky.agents.archive(agentId)
funky.agents.listVersions(agentId, ...)
funky.agents.iterVersions(agentId, ...)
funky.agents.retrieveVersion(agentId, version)

funky.environments.create(...)
funky.environments.list(...)
funky.environments.iter(...)
funky.environments.retrieve(environmentId)
funky.environments.update(environmentId, ...)
funky.environments.archive(environmentId)
funky.environments.delete(environmentId)

funky.sessions.create(...)
funky.sessions.list(...)
funky.sessions.iter(...)
funky.sessions.retrieve(sessionId)
funky.sessions.archive(sessionId)
funky.sessions.sendMessage(sessionId, ...)
funky.sessions.runTurn(sessionId, ...)
funky.sessions.listEvents(sessionId, ...)
funky.sessions.iterEvents(sessionId, ...)
funky.sessions.streamEvents(sessionId, ...)
funky.sessions.waitUntilReady(sessionId, ...)
funky.sessions.waitForTurn(sessionId, ...)
```

Create operations generate a stable UUID by default, making the request safe to
retry. Pass `id` explicitly when the caller needs to control that UUID.

## Pagination

Use `list()` when page metadata matters, or consume the auto-paginating async
iterator:

```ts
for await (const agent of funky.agents.iter({ include_archived: true })) {
  console.log(agent.id, agent.name);
}

for await (const event of funky.sessions.iterEvents(session.id, {
  after_seq: 0,
})) {
  console.log(event.seq, event.type);
}
```

## Live events

`streamEvents()` replays persisted events and follows the live SSE stream. It
automatically reconnects from the last consumed sequence and deduplicates replayed
events.

```ts
import { isSessionEvent } from "funky-sdk";

const controller = new AbortController();
const stream = funky.sessions.streamEvents(session.id, {
  after_seq: 0,
  signal: controller.signal,
});

try {
  for await (const event of stream) {
    if (isSessionEvent(event, "assistant_message")) {
      // Process content or tool calls.
    } else if (isSessionEvent(event, "turn_completed")) {
      break;
    } else if (isSessionEvent(event, "turn_failed")) {
      throw new Error(event.payload.message);
    }
  }
} finally {
  stream.close();
}
```

Heartbeat comments are ignored. Unknown future event, content-block, and tool-call
variants do not fail parsing; their original data is available through `raw`.

## Errors

All SDK errors extend `FunkyError`:

```text
FunkyError
├── APIConnectionError
│   └── APITimeoutError
├── APIStatusError
│   ├── BadRequestError
│   ├── AuthenticationError
│   ├── PermissionDeniedError
│   ├── NotFoundError
│   ├── ConflictError
│   ├── RateLimitError
│   └── InternalServerError
└── TurnFailedError
```

`APIStatusError` retains `status_code`, `error_type`, `code`, `request_id`,
response headers, and a safely redacted response body. `TurnFailedError` retains
the event's `error_class`, `session_id`, and `seq`.

Automatic retries are conservative: reads, stable-ID creates, and archive
operations retry transient failures; updates and messages do not retry after
ambiguous failures. SSE streams reconnect from the last yielded event.

## Client configuration

```ts
const funky = new Funky({
  apiKey: "fk_...",                 // defaults from FUNKY_API_KEY
  baseURL: "https://api.funky.dev",
  timeout: 30,                     // seconds
  maxRetries: 2,
  userAgent: "my-service/1.0",
  fetch: customFetch,              // useful for custom transports and tests
});
```

`timeoutMs` is available when millisecond configuration is more convenient.
`close()` aborts active requests and event streams. The client never includes the
API key in its string representation or API exceptions.
