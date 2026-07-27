import {
  APIConnectionError,
  APITimeoutError,
  statusError,
} from "./errors";
import {
  addQuery,
  isAbortError,
  type QueryValue,
  retryDelay,
  sleep,
} from "./utils";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RetryMode = "none" | "safe";

export interface TransportOptions {
  apiKey: string;
  baseURL: string;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
  fetch: Fetch;
}

export interface RequestOptions {
  params?: Record<string, QueryValue>;
  json?: unknown;
  retry?: RetryMode;
  signal?: AbortSignal;
}

export interface OpenStreamResponse {
  response: Response;
  close: () => void;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function linkSignal(
  controller: AbortController,
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const abort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 20_000) };
  }
}

export class Transport {
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;

  #fetch: Fetch;
  #headers: Record<string, string>;
  #controllers = new Set<AbortController>();
  #closers = new Set<() => void>();
  #closed = false;

  constructor(options: TransportOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.#fetch = options.fetch;
    this.#headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "User-Agent": options.userAgent,
      Accept: "application/json",
    };
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    const retry = options.retry ?? "none";
    const attempts = retry === "safe" ? this.maxRetries + 1 : 1;
    const body =
      options.json === undefined ? undefined : JSON.stringify(options.json);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      this.#controllers.add(controller);
      const unlink = linkSignal(controller, options.signal);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        unlink();
        this.#controllers.delete(controller);
      };

      let response: Response;
      try {
        const headers = { ...this.#headers };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const performFetch = this.#fetch;
        response = await performFetch(
          addQuery(this.baseURL, path, options.params),
          {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        cleanup();
        if (options.signal?.aborted) throw options.signal.reason;
        const mapped = timedOut || isAbortError(error)
          ? new APITimeoutError("Request to the Funky API timed out")
          : new APIConnectionError("Could not connect to the Funky API");
        if (retry === "safe" && attempt + 1 < attempts) {
          await sleep(retryDelay(undefined, attempt), options.signal);
          continue;
        }
        throw mapped;
      }

      if (
        retry === "safe" &&
        RETRYABLE_STATUSES.has(response.status) &&
        attempt + 1 < attempts
      ) {
        await response.body?.cancel().catch(() => undefined);
        cleanup();
        await sleep(retryDelay(response, attempt), options.signal);
        continue;
      }

      let payload: unknown;
      try {
        payload = await responsePayload(response);
      } catch (error) {
        cleanup();
        if (options.signal?.aborted) throw options.signal.reason;
        const mapped = timedOut || isAbortError(error)
          ? new APITimeoutError("Request to the Funky API timed out")
          : new APIConnectionError("Could not read the Funky API response");
        if (retry === "safe" && attempt + 1 < attempts) {
          await sleep(retryDelay(undefined, attempt), options.signal);
          continue;
        }
        throw mapped;
      }
      cleanup();
      if (!response.ok) throw statusError(response.status, payload, response.headers);
      return payload as T;
    }

    throw new APIConnectionError("Could not connect to the Funky API");
  }

  async openStream(
    path: string,
    params: Record<string, QueryValue>,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<OpenStreamResponse> {
    this.#assertOpen();
    const controller = new AbortController();
    this.#controllers.add(controller);
    const unlink = linkSignal(controller, signal);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const performFetch = this.#fetch;
      const response = await performFetch(addQuery(this.baseURL, path, params), {
        method: "GET",
        headers: { ...this.#headers, ...headers },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      let active = true;
      return {
        response,
        close: () => {
          if (!active) return;
          active = false;
          unlink();
          controller.abort();
          this.#controllers.delete(controller);
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      unlink();
      this.#controllers.delete(controller);
      if (signal.aborted) throw signal.reason;
      if (timedOut || isAbortError(error)) {
        throw new APITimeoutError("Request to the Funky API timed out");
      }
      throw new APIConnectionError("Could not connect to the Funky API");
    }
  }

  registerCloser(closer: () => void): () => void {
    this.#assertOpen();
    this.#closers.add(closer);
    return () => this.#closers.delete(closer);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const closer of this.#closers) closer();
    this.#closers.clear();
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  #assertOpen(): void {
    if (this.#closed) throw new FunkyClientClosedError();
  }
}

class FunkyClientClosedError extends APIConnectionError {
  constructor() {
    super("The Funky client is closed");
  }
}
