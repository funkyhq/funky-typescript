import { randomUUID } from "node:crypto";

import {
  APITimeoutError,
  FunkyError,
  TurnFailedError,
} from "./errors";
import {
  type Agent,
  type AgentReference,
  type AgentVersion,
  type AssistantMessageEvent,
  type Environment,
  type EventPage,
  type LimitedNetwork,
  type Metadata,
  type ModelConfig,
  type Page,
  parseAgent,
  parseAgentVersion,
  parseEnvironment,
  parseSession,
  parseSessionEvent,
  type RunTurnResult,
  type RuntimeConfig,
  type SendMessageResponse,
  type Session,
  type SessionEvent,
  type TextContentBlock,
  type ToolPolicy,
  type TurnCompletedEvent,
  type TurnFailedEvent,
  type UnrestrictedNetwork,
  type VersionPage,
} from "./models";
import { EventStream, type StreamEventsOptions } from "./streaming";
import type { Transport } from "./transport";
import { pathId, sleep } from "./utils";

interface RequestControl {
  signal?: AbortSignal;
}

export interface AgentCreateParams extends RequestControl {
  id?: string;
  name: string;
  description?: string | null;
  metadata?: Metadata;
  system_prompt: string;
  model: ModelConfig;
  tool_policy?: ToolPolicy;
  runtime?: RuntimeConfig | null;
}

export interface AgentUpdateParams extends RequestControl {
  name?: string;
  description?: string | null;
  metadata?: Metadata;
  system_prompt?: string;
  model?: ModelConfig;
  tool_policy?: ToolPolicy;
  runtime?: RuntimeConfig | null;
}

export interface ListParams extends RequestControl {
  limit?: number;
  after_id?: string;
  include_archived?: boolean;
}

export interface IterateParams extends RequestControl {
  limit?: number;
  include_archived?: boolean;
}

export interface ListVersionsParams extends RequestControl {
  limit?: number;
  after_version?: number;
}

export interface IterateVersionsParams extends RequestControl {
  limit?: number;
}

export interface EnvironmentCreateParams extends RequestControl {
  id?: string;
  name: string;
  description?: string | null;
  metadata?: Metadata;
  network?: LimitedNetwork | UnrestrictedNetwork;
}

export interface EnvironmentUpdateParams extends RequestControl {
  name?: string;
  description?: string | null;
  metadata?: Metadata;
  network?: LimitedNetwork | UnrestrictedNetwork;
}

export interface SessionCreateParams extends RequestControl {
  id?: string;
  agent: string | AgentReference;
  environment_id: string;
  title?: string | null;
  metadata?: Metadata;
}

export interface SendMessageParams extends RequestControl {
  content: string;
}

export interface ListEventsParams extends RequestControl {
  after_seq?: number;
  limit?: number;
}

export interface IterateEventsParams extends RequestControl {
  after_seq?: number;
  limit?: number;
}

export interface WaitOptions extends RequestControl {
  /** Timeout in seconds, matching the Python SDK. */
  timeout?: number;
  /** Poll interval in seconds, matching the Python SDK. */
  poll_interval?: number;
  /** Explicit millisecond alternative to `timeout`. */
  timeout_ms?: number;
  /** Explicit millisecond alternative to `poll_interval`. */
  poll_interval_ms?: number;
}

export interface WaitForTurnOptions extends WaitOptions {
  after_seq?: number;
}

function waitMilliseconds(
  options: WaitOptions,
  defaults: { timeout: number; pollInterval: number },
): { timeout: number; pollInterval: number } {
  return {
    timeout:
      options.timeout_ms ?? (options.timeout ?? defaults.timeout) * 1_000,
    pollInterval:
      options.poll_interval_ms ??
      (options.poll_interval ?? defaults.pollInterval) * 1_000,
  };
}

function page<T>(
  raw: { data: unknown[]; has_more: boolean; last_id?: string },
  parse: (value: unknown) => T,
): Page<T> {
  const result: Page<T> = {
    data: raw.data.map(parse),
    has_more: raw.has_more,
  };
  if (raw.last_id !== undefined) result.last_id = raw.last_id;
  return result;
}

export class Agents {
  #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  async create(params: AgentCreateParams): Promise<Agent> {
    const { signal, ...body } = params;
    const payload = { ...body, id: body.id ?? randomUUID() };
    const raw = await this.#transport.request(
      "POST",
      "/v1/agents",
      { json: payload, retry: "safe", ...(signal ? { signal } : {}) },
    );
    return parseAgent(raw);
  }

  async list(params: ListParams = {}): Promise<Page<Agent>> {
    const {
      limit = 20,
      after_id,
      include_archived = false,
      signal,
    } = params;
    const raw = await this.#transport.request<{
      data: unknown[];
      has_more: boolean;
      last_id?: string;
    }>("GET", "/v1/agents", {
      params: { limit, after_id, include_archived },
      retry: "safe",
      ...(signal ? { signal } : {}),
    });
    return page(raw, parseAgent);
  }

  async *iter(params: IterateParams = {}): AsyncGenerator<Agent> {
    let after_id: string | undefined;
    do {
      const current = await this.list({
        ...params,
        limit: params.limit ?? 100,
        ...(after_id ? { after_id } : {}),
      });
      yield* current.data;
      if (!current.has_more || !current.last_id) return;
      after_id = current.last_id;
    } while (true);
  }

  async retrieve(agentId: string, control: RequestControl = {}): Promise<Agent> {
    const raw = await this.#transport.request(
      "GET",
      `/v1/agents/${pathId(agentId)}`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseAgent(raw);
  }

  async update(agentId: string, params: AgentUpdateParams): Promise<Agent> {
    const { signal, ...body } = params;
    if (Object.keys(body).length === 0) {
      throw new TypeError("At least one agent field must be supplied");
    }
    const raw = await this.#transport.request(
      "POST",
      `/v1/agents/${pathId(agentId)}`,
      { json: body, ...(signal ? { signal } : {}) },
    );
    return parseAgent(raw);
  }

  async archive(agentId: string, control: RequestControl = {}): Promise<Agent> {
    const raw = await this.#transport.request(
      "POST",
      `/v1/agents/${pathId(agentId)}/archive`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseAgent(raw);
  }

  async listVersions(
    agentId: string,
    params: ListVersionsParams = {},
  ): Promise<VersionPage> {
    const { limit = 20, after_version, signal } = params;
    const raw = await this.#transport.request<{
      data: unknown[];
      has_more: boolean;
    }>("GET", `/v1/agents/${pathId(agentId)}/versions`, {
      params: { limit, after_version },
      retry: "safe",
      ...(signal ? { signal } : {}),
    });
    return {
      data: raw.data.map(parseAgentVersion),
      has_more: raw.has_more,
    };
  }

  async *iterVersions(
    agentId: string,
    params: IterateVersionsParams = {},
  ): AsyncGenerator<AgentVersion> {
    let after_version: number | undefined;
    do {
      const current = await this.listVersions(agentId, {
        ...params,
        limit: params.limit ?? 100,
        ...(after_version === undefined ? {} : { after_version }),
      });
      yield* current.data;
      if (!current.has_more || current.data.length === 0) return;
      after_version = current.data.at(-1)?.version;
    } while (after_version !== undefined);
  }

  async retrieveVersion(
    agentId: string,
    version: number,
    control: RequestControl = {},
  ): Promise<AgentVersion> {
    const raw = await this.#transport.request(
      "GET",
      `/v1/agents/${pathId(agentId)}/versions/${version}`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseAgentVersion(raw);
  }

  list_versions(
    agentId: string,
    params: ListVersionsParams = {},
  ): Promise<VersionPage> {
    return this.listVersions(agentId, params);
  }

  iter_versions(
    agentId: string,
    params: IterateVersionsParams = {},
  ): AsyncGenerator<AgentVersion> {
    return this.iterVersions(agentId, params);
  }

  retrieve_version(
    agentId: string,
    version: number,
    control: RequestControl = {},
  ): Promise<AgentVersion> {
    return this.retrieveVersion(agentId, version, control);
  }
}

export class Environments {
  #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  async create(params: EnvironmentCreateParams): Promise<Environment> {
    const { signal, ...body } = params;
    const payload = { ...body, id: body.id ?? randomUUID() };
    const raw = await this.#transport.request(
      "POST",
      "/v1/environments",
      { json: payload, retry: "safe", ...(signal ? { signal } : {}) },
    );
    return parseEnvironment(raw);
  }

  async list(params: ListParams = {}): Promise<Page<Environment>> {
    const {
      limit = 20,
      after_id,
      include_archived = false,
      signal,
    } = params;
    const raw = await this.#transport.request<{
      data: unknown[];
      has_more: boolean;
      last_id?: string;
    }>("GET", "/v1/environments", {
      params: { limit, after_id, include_archived },
      retry: "safe",
      ...(signal ? { signal } : {}),
    });
    return page(raw, parseEnvironment);
  }

  async *iter(params: IterateParams = {}): AsyncGenerator<Environment> {
    let after_id: string | undefined;
    do {
      const current = await this.list({
        ...params,
        limit: params.limit ?? 100,
        ...(after_id ? { after_id } : {}),
      });
      yield* current.data;
      if (!current.has_more || !current.last_id) return;
      after_id = current.last_id;
    } while (true);
  }

  async retrieve(
    environmentId: string,
    control: RequestControl = {},
  ): Promise<Environment> {
    const raw = await this.#transport.request(
      "GET",
      `/v1/environments/${pathId(environmentId)}`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseEnvironment(raw);
  }

  async update(
    environmentId: string,
    params: EnvironmentUpdateParams,
  ): Promise<Environment> {
    const { signal, ...body } = params;
    if (Object.keys(body).length === 0) {
      throw new TypeError("At least one environment field must be supplied");
    }
    const raw = await this.#transport.request(
      "POST",
      `/v1/environments/${pathId(environmentId)}`,
      { json: body, ...(signal ? { signal } : {}) },
    );
    return parseEnvironment(raw);
  }

  async archive(
    environmentId: string,
    control: RequestControl = {},
  ): Promise<Environment> {
    const raw = await this.#transport.request(
      "POST",
      `/v1/environments/${pathId(environmentId)}/archive`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseEnvironment(raw);
  }

  async delete(environmentId: string, control: RequestControl = {}): Promise<void> {
    // Fetch cannot distinguish a pre-send connection failure from an ambiguous
    // disconnect, so DELETE is deliberately not retried.
    await this.#transport.request(
      "DELETE",
      `/v1/environments/${pathId(environmentId)}`,
      control.signal ? { signal: control.signal } : {},
    );
  }
}

export class Sessions {
  #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  async create(params: SessionCreateParams): Promise<Session> {
    const { signal, ...body } = params;
    const payload = { ...body, id: body.id ?? randomUUID() };
    const raw = await this.#transport.request(
      "POST",
      "/v1/sessions",
      { json: payload, retry: "safe", ...(signal ? { signal } : {}) },
    );
    return parseSession(raw);
  }

  async list(params: ListParams = {}): Promise<Page<Session>> {
    const {
      limit = 20,
      after_id,
      include_archived = false,
      signal,
    } = params;
    const raw = await this.#transport.request<{
      data: unknown[];
      has_more: boolean;
      last_id?: string;
    }>("GET", "/v1/sessions", {
      params: { limit, after_id, include_archived },
      retry: "safe",
      ...(signal ? { signal } : {}),
    });
    return page(raw, parseSession);
  }

  async *iter(params: IterateParams = {}): AsyncGenerator<Session> {
    let after_id: string | undefined;
    do {
      const current = await this.list({
        ...params,
        limit: params.limit ?? 100,
        ...(after_id ? { after_id } : {}),
      });
      yield* current.data;
      if (!current.has_more || !current.last_id) return;
      after_id = current.last_id;
    } while (true);
  }

  async retrieve(
    sessionId: string,
    control: RequestControl = {},
  ): Promise<Session> {
    const raw = await this.#transport.request(
      "GET",
      `/v1/sessions/${pathId(sessionId)}`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseSession(raw);
  }

  async archive(
    sessionId: string,
    control: RequestControl = {},
  ): Promise<Session> {
    const raw = await this.#transport.request(
      "POST",
      `/v1/sessions/${pathId(sessionId)}/archive`,
      { retry: "safe", ...(control.signal ? { signal: control.signal } : {}) },
    );
    return parseSession(raw);
  }

  async sendMessage(
    sessionId: string,
    params: SendMessageParams,
  ): Promise<SendMessageResponse> {
    const { signal, ...body } = params;
    return this.#transport.request(
      "POST",
      `/v1/sessions/${pathId(sessionId)}/messages`,
      { json: body, ...(signal ? { signal } : {}) },
    );
  }

  async runTurn(
    sessionId: string,
    params: SendMessageParams,
  ): Promise<RunTurnResult> {
    const submission = await this.sendMessage(sessionId, params);
    const events: SessionEvent[] = [];
    const stream = this.streamEvents(sessionId, {
      after_seq: submission.seq,
      ...(params.signal ? { signal: params.signal } : {}),
    });

    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "turn_failed") {
          const failed = event as TurnFailedEvent;
          throw new TurnFailedError(failed.payload.message, {
            error_class: failed.payload.error_class,
            session_id: failed.session_id,
            seq: failed.seq,
          });
        }
        if (event.type === "turn_completed") {
          const messages: string[] = [];
          for (const observed of events) {
            if (observed.type !== "assistant_message") continue;
            const assistant = observed as AssistantMessageEvent;
            const text = assistant.payload.content
              .filter(
                (block): block is TextContentBlock => block.type === "text",
              )
              .map((block) => block.text)
              .join("");
            if (text) messages.push(text);
          }
          return {
            output_text: messages.join("\n"),
            submission,
            events,
            terminal_event: event as TurnCompletedEvent,
          };
        }
      }
    } finally {
      stream.close();
    }
    throw new FunkyError(
      `Event stream for session ${sessionId} ended before the turn completed`,
    );
  }

  async listEvents(
    sessionId: string,
    params: ListEventsParams = {},
  ): Promise<EventPage> {
    const { after_seq = 0, limit = 100, signal } = params;
    const raw = await this.#transport.request<{
      data: unknown[];
      has_more: boolean;
      last_seq: number;
    }>("GET", `/v1/sessions/${pathId(sessionId)}/events`, {
      params: { after_seq, limit },
      retry: "safe",
      ...(signal ? { signal } : {}),
    });
    return {
      data: raw.data.map(parseSessionEvent),
      has_more: raw.has_more,
      last_seq: raw.last_seq,
    };
  }

  async *iterEvents(
    sessionId: string,
    params: IterateEventsParams = {},
  ): AsyncGenerator<SessionEvent> {
    let cursor = params.after_seq ?? 0;
    do {
      const current = await this.listEvents(sessionId, {
        ...params,
        after_seq: cursor,
        limit: params.limit ?? 500,
      });
      yield* current.data;
      if (!current.has_more || current.data.length === 0) return;
      cursor = current.data.at(-1)?.seq ?? cursor;
    } while (true);
  }

  streamEvents(
    sessionId: string,
    options: StreamEventsOptions = {},
  ): EventStream {
    return new EventStream(this.#transport, sessionId, options);
  }

  async waitUntilReady(
    sessionId: string,
    options: WaitOptions = {},
  ): Promise<Session> {
    const { timeout, pollInterval } = waitMilliseconds(options, {
      timeout: 180,
      pollInterval: 1,
    });
    const deadline = Date.now() + timeout;
    while (true) {
      const session = await this.retrieve(
        sessionId,
        options.signal ? { signal: options.signal } : {},
      );
      if (session.status === "ready") return session;
      if (session.status === "failed" || session.status === "archived") {
        throw new FunkyError(
          `Session ${sessionId} entered terminal status "${session.status}"`,
        );
      }
      if (Date.now() >= deadline) {
        throw new APITimeoutError(
          `Timed out waiting for session ${sessionId} to be ready`,
        );
      }
      await sleep(
        Math.min(pollInterval, Math.max(0, deadline - Date.now())),
        options.signal,
      );
    }
  }

  async waitForTurn(
    sessionId: string,
    options: WaitForTurnOptions = {},
  ): Promise<TurnCompletedEvent | TurnFailedEvent> {
    const { timeout, pollInterval } = waitMilliseconds(options, {
      timeout: 300,
      pollInterval: 1,
    });
    const deadline = Date.now() + timeout;
    let cursor = options.after_seq ?? 0;
    while (true) {
      const current = await this.listEvents(sessionId, {
        after_seq: cursor,
        limit: 500,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for (const event of current.data) {
        cursor = event.seq;
        if (event.type === "turn_completed" || event.type === "turn_failed") {
          return event as TurnCompletedEvent | TurnFailedEvent;
        }
      }
      if (current.has_more && current.data.length > 0) continue;
      if (Date.now() >= deadline) {
        throw new APITimeoutError(
          `Timed out waiting for a turn in session ${sessionId}`,
        );
      }
      await sleep(
        Math.min(pollInterval, Math.max(0, deadline - Date.now())),
        options.signal,
      );
    }
  }

  send_message(
    sessionId: string,
    params: SendMessageParams,
  ): Promise<SendMessageResponse> {
    return this.sendMessage(sessionId, params);
  }

  run_turn(sessionId: string, params: SendMessageParams): Promise<RunTurnResult> {
    return this.runTurn(sessionId, params);
  }

  list_events(
    sessionId: string,
    params: ListEventsParams = {},
  ): Promise<EventPage> {
    return this.listEvents(sessionId, params);
  }

  iter_events(
    sessionId: string,
    params: IterateEventsParams = {},
  ): AsyncGenerator<SessionEvent> {
    return this.iterEvents(sessionId, params);
  }

  stream_events(
    sessionId: string,
    options: StreamEventsOptions = {},
  ): EventStream {
    return this.streamEvents(sessionId, options);
  }

  wait_until_ready(
    sessionId: string,
    options: WaitOptions = {},
  ): Promise<Session> {
    return this.waitUntilReady(sessionId, options);
  }

  wait_for_turn(
    sessionId: string,
    options: WaitForTurnOptions = {},
  ): Promise<TurnCompletedEvent | TurnFailedEvent> {
    return this.waitForTurn(sessionId, options);
  }
}
