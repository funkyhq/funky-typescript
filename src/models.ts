export type Metadata = Record<string, string>;
export type ToolPolicy = Record<string, unknown>;

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "openrouter"
  | "togetherai"
  | "fireworks"
  | "baseten";

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  max_tokens?: number;
  temperature?: number;
}

export interface RuntimeConfig {
  type: "native" | "claude-code";
}

export interface UnrestrictedNetwork {
  type: "unrestricted";
}

export interface LimitedNetwork {
  type: "limited";
  allowed_hosts: string[];
}

export type Network = UnrestrictedNetwork | LimitedNetwork;

export interface AgentReference {
  id: string;
  version: number;
}

export interface Agent {
  type: "agent";
  id: string;
  name: string;
  description: string | null;
  metadata: Metadata;
  version: number;
  system_prompt: string;
  model: ModelConfig;
  tool_policy: ToolPolicy;
  runtime: RuntimeConfig | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface AgentVersion {
  type: "agent_version";
  agent_id: string;
  version: number;
  system_prompt: string;
  model: ModelConfig;
  tool_policy: ToolPolicy;
  runtime: RuntimeConfig | null;
  created_at: Date;
  created_by: string | null;
}

export interface Environment {
  type: "environment";
  id: string;
  name: string;
  description: string | null;
  metadata: Metadata;
  network: Network;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export type SessionStatus = "provisioning" | "ready" | "failed" | "archived";

export interface Session {
  type: "session";
  id: string;
  status: SessionStatus;
  agent: AgentReference;
  environment_id: string;
  title: string | null;
  metadata: Metadata;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

export interface SendMessageResponse {
  turn: "queued";
  seq: number;
}

export interface Page<T> {
  data: T[];
  has_more: boolean;
  last_id?: string;
}

export interface VersionPage {
  data: AgentVersion[];
  has_more: boolean;
}

export interface EventPage {
  data: SessionEvent[];
  has_more: boolean;
  last_seq: number;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface UnknownContentBlock {
  type: string;
  raw: Record<string, unknown>;
}

export type ContentBlock = TextContentBlock | UnknownContentBlock;

export interface ExecToolCall {
  kind: "exec";
  cmd: string;
  timeout_ms?: number;
}

export interface UnknownToolCall {
  kind: string;
  raw: Record<string, unknown>;
}

export type ToolCall = ExecToolCall | UnknownToolCall;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type EmptyPayload = Record<string, never>;

export interface MessagePayload {
  content: ContentBlock[];
}

export interface AssistantMessagePayload {
  content: ContentBlock[];
  tool_calls: ToolCall[];
  usage?: Usage;
}

export interface ToolResultPayload {
  idem_key: string;
  output: string;
  exit_code: number;
  truncated: boolean;
}

export type TurnErrorClass =
  | "LLM_PERMANENT"
  | "SANDBOX_FATAL"
  | "BUDGET"
  | "HARNESS"
  | "INTERNAL";

export interface TurnFailedPayload {
  error_class: TurnErrorClass | (string & {});
  message: string;
}

export interface HarnessAttemptStartedPayload {
  attempt: string;
  resumed_from: string | null;
}

interface BaseSessionEvent<TType extends string, TPayload> {
  type: TType;
  seq: number;
  session_id: string;
  created_at: Date;
  payload: TPayload;
}

export type SessionProvisionedEvent = BaseSessionEvent<"session_provisioned", EmptyPayload>;
export type UserMessageEvent = BaseSessionEvent<"user_message", MessagePayload>;
export type AssistantMessageEvent = BaseSessionEvent<
  "assistant_message",
  AssistantMessagePayload
>;
export type ToolResultEvent = BaseSessionEvent<"tool_result", ToolResultPayload>;
export type TurnCompletedEvent = BaseSessionEvent<"turn_completed", EmptyPayload>;
export type TurnFailedEvent = BaseSessionEvent<"turn_failed", TurnFailedPayload>;
export type HarnessAttemptStartedEvent = BaseSessionEvent<
  "harness_attempt_started",
  HarnessAttemptStartedPayload
>;

export interface UnknownSessionEvent
  extends BaseSessionEvent<string, Record<string, unknown>> {
  raw: Record<string, unknown>;
}

export type KnownSessionEvent =
  | SessionProvisionedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | HarnessAttemptStartedEvent;

export type SessionEvent = KnownSessionEvent | UnknownSessionEvent;

export type KnownSessionEventType = KnownSessionEvent["type"];

export function isSessionEvent<TType extends KnownSessionEventType>(
  event: SessionEvent,
  type: TType,
): event is Extract<KnownSessionEvent, { type: TType }> {
  return event.type === type;
}

export interface RunTurnResult {
  output_text: string;
  submission: SendMessageResponse;
  events: SessionEvent[];
  terminal_event: TurnCompletedEvent;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(string(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function metadata(value: unknown): Metadata {
  return { ...(record(value) as Metadata) };
}

export function parseAgent(value: unknown): Agent {
  const raw = record(value);
  return {
    type: "agent",
    id: string(raw.id),
    name: string(raw.name),
    description:
      raw.description === null || raw.description === undefined
        ? null
        : string(raw.description),
    metadata: metadata(raw.metadata),
    version: number(raw.version),
    system_prompt: string(raw.system_prompt),
    model: record(raw.model) as unknown as ModelConfig,
    tool_policy: { ...record(raw.tool_policy) },
    runtime:
      raw.runtime === null || raw.runtime === undefined
        ? null
        : (record(raw.runtime) as unknown as RuntimeConfig),
    created_at: date(raw.created_at),
    updated_at: date(raw.updated_at),
    archived_at: nullableDate(raw.archived_at),
  };
}

export function parseAgentVersion(value: unknown): AgentVersion {
  const raw = record(value);
  return {
    type: "agent_version",
    agent_id: string(raw.agent_id),
    version: number(raw.version),
    system_prompt: string(raw.system_prompt),
    model: record(raw.model) as unknown as ModelConfig,
    tool_policy: { ...record(raw.tool_policy) },
    runtime:
      raw.runtime === null || raw.runtime === undefined
        ? null
        : (record(raw.runtime) as unknown as RuntimeConfig),
    created_at: date(raw.created_at),
    created_by:
      raw.created_by === null || raw.created_by === undefined
        ? null
        : string(raw.created_by),
  };
}

export function parseEnvironment(value: unknown): Environment {
  const raw = record(value);
  const rawNetwork = record(raw.network);
  const network: Network =
    rawNetwork.type === "limited"
      ? {
          type: "limited",
          allowed_hosts: Array.isArray(rawNetwork.allowed_hosts)
            ? rawNetwork.allowed_hosts.map((host) => string(host))
            : [],
        }
      : { type: "unrestricted" };
  return {
    type: "environment",
    id: string(raw.id),
    name: string(raw.name),
    description:
      raw.description === null || raw.description === undefined
        ? null
        : string(raw.description),
    metadata: metadata(raw.metadata),
    network,
    created_at: date(raw.created_at),
    updated_at: date(raw.updated_at),
    archived_at: nullableDate(raw.archived_at),
  };
}

export function parseSession(value: unknown): Session {
  const raw = record(value);
  const agent = record(raw.agent);
  return {
    type: "session",
    id: string(raw.id),
    status: string(raw.status) as SessionStatus,
    agent: { id: string(agent.id), version: number(agent.version) },
    environment_id: string(raw.environment_id),
    title:
      raw.title === null || raw.title === undefined ? null : string(raw.title),
    metadata: metadata(raw.metadata),
    created_at: date(raw.created_at),
    updated_at: date(raw.updated_at),
    archived_at: nullableDate(raw.archived_at),
  };
}

function parseContentBlock(value: unknown): ContentBlock {
  const raw = record(value);
  if (raw.type === "text") {
    return { type: "text", text: string(raw.text) };
  }
  return { type: string(raw.type, "unknown"), raw: { ...raw } };
}

function parseToolCall(value: unknown): ToolCall {
  const raw = record(value);
  if (raw.kind === "exec") {
    const call: ExecToolCall = { kind: "exec", cmd: string(raw.cmd) };
    if (raw.timeout_ms !== null && raw.timeout_ms !== undefined) {
      call.timeout_ms = number(raw.timeout_ms);
    }
    return call;
  }
  return { kind: string(raw.kind, "unknown"), raw: { ...raw } };
}

export function parseSessionEvent(value: unknown): SessionEvent {
  const raw = record(value);
  const type = string(raw.type, "unknown");
  const payload = record(raw.payload);
  const common = {
    seq: number(raw.seq),
    session_id: string(raw.session_id),
    created_at: date(raw.created_at),
  };

  switch (type) {
    case "session_provisioned":
      return { type, payload: {}, ...common };
    case "user_message":
      return {
        type,
        payload: {
          content: Array.isArray(payload.content)
            ? payload.content.map(parseContentBlock)
            : [],
        },
        ...common,
      };
    case "assistant_message": {
      const assistantPayload: AssistantMessagePayload = {
        content: Array.isArray(payload.content)
          ? payload.content.map(parseContentBlock)
          : [],
        tool_calls: Array.isArray(payload.tool_calls)
          ? payload.tool_calls.map(parseToolCall)
          : [],
      };
      const rawUsage = record(payload.usage);
      if (Object.keys(rawUsage).length > 0) {
        assistantPayload.usage = {
          input_tokens: number(rawUsage.input_tokens),
          output_tokens: number(rawUsage.output_tokens),
        };
      }
      return { type, payload: assistantPayload, ...common };
    }
    case "tool_result":
      return {
        type,
        payload: {
          idem_key: string(payload.idem_key),
          output: string(payload.output),
          exit_code: number(payload.exit_code),
          truncated: Boolean(payload.truncated),
        },
        ...common,
      };
    case "turn_completed":
      return { type, payload: {}, ...common };
    case "turn_failed":
      return {
        type,
        payload: {
          error_class: string(payload.error_class) as TurnFailedPayload["error_class"],
          message: string(payload.message),
        },
        ...common,
      };
    case "harness_attempt_started":
      return {
        type,
        payload: {
          attempt: string(payload.attempt),
          resumed_from:
            payload.resumed_from === null || payload.resumed_from === undefined
              ? null
              : string(payload.resumed_from),
        },
        ...common,
      };
    default:
      return {
        type,
        payload: { ...payload },
        raw: { ...raw },
        ...common,
      };
  }
}
