const SENSITIVE_KEYS = new Set(["api_key", "authorization", "token", "secret"]);
const FUNKY_KEY_PATTERN = /\bfk_[A-Za-z0-9_-]+\b/g;

export class FunkyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class APIConnectionError extends FunkyError {}

export class APITimeoutError extends APIConnectionError {}

export class TurnFailedError extends FunkyError {
  readonly error_class: string;
  readonly session_id: string;
  readonly seq: number;

  constructor(
    message: string,
    options: { error_class: string; session_id: string; seq: number },
  ) {
    super(message);
    this.error_class = options.error_class;
    this.session_id = options.session_id;
    this.seq = options.seq;
  }
}

export interface APIStatusErrorOptions {
  status_code: number;
  error_type?: string;
  code?: string;
  request_id?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export class APIStatusError extends FunkyError {
  readonly status_code: number;
  readonly error_type: string | undefined;
  readonly code: string | undefined;
  readonly request_id: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;

  constructor(message: string, options: APIStatusErrorOptions) {
    super(redactString(message));
    this.status_code = options.status_code;
    this.error_type = options.error_type;
    this.code = options.code;
    this.request_id = options.request_id;
    this.headers = { ...options.headers };
    this.body = options.body;
  }

  get statusCode(): number {
    return this.status_code;
  }

  get errorType(): string | undefined {
    return this.error_type;
  }

  get requestId(): string | undefined {
    return this.request_id;
  }

  override toString(): string {
    const details = [`status=${this.status_code}`];
    if (this.code) details.push(`code=${this.code}`);
    if (this.request_id) details.push(`request_id=${this.request_id}`);
    return `${this.message} (${details.join(", ")})`;
  }
}

export class BadRequestError extends APIStatusError {}
export class AuthenticationError extends APIStatusError {}
export class PermissionDeniedError extends APIStatusError {}
export class NotFoundError extends APIStatusError {}
export class ConflictError extends APIStatusError {}
export class RateLimitError extends APIStatusError {}
export class InternalServerError extends APIStatusError {}

type ErrorConstructor = new (
  message: string,
  options: APIStatusErrorOptions,
) => APIStatusError;

const STATUS_ERRORS: Record<number, ErrorConstructor> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  429: RateLimitError,
  500: InternalServerError,
  502: InternalServerError,
  503: InternalServerError,
  504: InternalServerError,
};

function redactString(value: string): string {
  return value.replace(FUNKY_KEY_PATTERN, "[REDACTED]");
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return typeof value === "string" ? redactString(value) : value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function statusError(
  status: number,
  payload: unknown,
  headers: Headers,
): APIStatusError {
  const safePayload = redact(payload);
  const envelope = record(safePayload);
  const error = record(envelope.error);
  const message =
    typeof error.message === "string"
      ? error.message
      : `Funky API request failed with status ${status}`;
  const requestId =
    typeof envelope.request_id === "string"
      ? envelope.request_id
      : (headers.get("request-id") ?? undefined);
  const ErrorClass = STATUS_ERRORS[status] ?? APIStatusError;
  const options: APIStatusErrorOptions = {
    status_code: status,
    headers: Object.fromEntries(headers.entries()),
    body: safePayload,
  };
  if (typeof error.type === "string") options.error_type = error.type;
  if (typeof error.code === "string") options.code = error.code;
  if (requestId !== undefined) options.request_id = requestId;
  return new ErrorClass(message, options);
}
