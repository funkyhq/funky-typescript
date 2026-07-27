import { Agents, Environments, Sessions } from "./resources";
import { type Fetch, Transport } from "./transport";
import { VERSION } from "./version";

export const DEFAULT_BASE_URL = "https://api.funky.dev";

export interface FunkyOptions {
  apiKey?: string;
  api_key?: string;
  baseURL?: string;
  base_url?: string;
  /** Request timeout in seconds, matching the Python SDK. */
  timeout?: number;
  /** Explicit millisecond alternative to `timeout`. */
  timeoutMs?: number;
  maxRetries?: number;
  max_retries?: number;
  userAgent?: string;
  user_agent?: string;
  fetch?: Fetch;
}

function environmentApiKey(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env.FUNKY_API_KEY;
}

export class Funky {
  readonly agents: Agents;
  readonly environments: Environments;
  readonly sessions: Sessions;

  #transport: Transport;
  #baseURL: string;

  constructor(options: FunkyOptions = {}) {
    const apiKey = options.apiKey ?? options.api_key ?? environmentApiKey();
    if (!apiKey) {
      throw new TypeError(
        "Funky API key is required; pass apiKey or set the FUNKY_API_KEY environment variable",
      );
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!fetchImplementation) {
      throw new TypeError(
        "A Fetch API implementation is required; use Node.js 20+ or pass fetch",
      );
    }
    this.#baseURL =
      options.baseURL ?? options.base_url ?? DEFAULT_BASE_URL;
    this.#transport = new Transport({
      apiKey,
      baseURL: this.#baseURL,
      timeoutMs: options.timeoutMs ?? (options.timeout ?? 30) * 1_000,
      maxRetries: options.maxRetries ?? options.max_retries ?? 2,
      userAgent:
        options.userAgent ??
        options.user_agent ??
        `funky-typescript/${VERSION}`,
      fetch: fetchImplementation,
    });
    this.agents = new Agents(this.#transport);
    this.environments = new Environments(this.#transport);
    this.sessions = new Sessions(this.#transport);
  }

  async health(options: { signal?: AbortSignal } = {}): Promise<{ status: string }> {
    return this.#transport.request("GET", "/health", {
      retry: "safe",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  close(): void {
    this.#transport.close();
  }

  toString(): string {
    return `Funky(baseURL="${this.#baseURL}")`;
  }
}
