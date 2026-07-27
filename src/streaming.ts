import { APIConnectionError, APITimeoutError, statusError } from "./errors";
import { parseSessionEvent, type SessionEvent } from "./models";
import { responsePayload, type Transport } from "./transport";
import { isAbortError, pathId, retryDelay, sleep } from "./utils";

interface SSEFrame {
  data: string;
  id?: string;
  event?: string;
  retry?: string;
}

async function* lines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* frames(
  source: AsyncIterable<string>,
): AsyncGenerator<SSEFrame> {
  let frame: Omit<SSEFrame, "data"> = {};
  let data: string[] = [];

  for await (const line of source) {
    if (line === "") {
      if (data.length > 0) yield { ...frame, data: data.join("\n") };
      frame = {};
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "id" || field === "event" || field === "retry") {
      frame[field] = value;
    }
  }

  if (data.length > 0) yield { ...frame, data: data.join("\n") };
}

export interface StreamEventsOptions {
  after_seq?: number;
  signal?: AbortSignal;
}

/**
 * A resumable SSE stream. It is consumed with `for await` and can be stopped
 * explicitly with `close()`.
 */
export class EventStream implements AsyncIterable<SessionEvent> {
  #transport: Transport;
  #sessionId: string;
  #initialAfterSeq: number;
  #cursor: number;
  #seen = new Set<string>();
  #closed = false;
  #controller: AbortController | undefined;
  #unregister: () => void;
  #externalSignal: AbortSignal | undefined;
  #externalAbort: (() => void) | undefined;

  constructor(
    transport: Transport,
    sessionId: string,
    options: StreamEventsOptions = {},
  ) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#initialAfterSeq = options.after_seq ?? 0;
    this.#cursor = this.#initialAfterSeq;
    this.#externalSignal = options.signal;
    this.#unregister = transport.registerCloser(() => this.close());

    if (options.signal) {
      this.#externalAbort = () => this.close(options.signal?.reason);
      if (options.signal.aborted) this.#externalAbort();
      else {
        options.signal.addEventListener("abort", this.#externalAbort, {
          once: true,
        });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this.#iterate();
  }

  close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller?.abort(reason);
    this.#unregister();
    if (this.#externalSignal && this.#externalAbort) {
      this.#externalSignal.removeEventListener("abort", this.#externalAbort);
    }
  }

  async *#iterate(): AsyncGenerator<SessionEvent> {
    let failures = 0;
    let firstRequest = true;
    try {
      while (!this.#closed) {
        const controller = new AbortController();
        this.#controller = controller;
        const params: Record<string, number> = {};
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (firstRequest) params.after_seq = this.#initialAfterSeq;
        else headers["Last-Event-ID"] = String(this.#cursor);
        firstRequest = false;

        let closeConnection: (() => void) | undefined;
        try {
          const connection = await this.#transport.openStream(
            `/v1/sessions/${pathId(this.#sessionId)}/events/stream`,
            params,
            headers,
            controller.signal,
          );
          const { response } = connection;
          closeConnection = connection.close;
          if (!response.ok) {
            const payload = await responsePayload(response);
            throw statusError(response.status, payload, response.headers);
          }
          if (!response.body) {
            throw new APIConnectionError("Funky event stream returned no response body");
          }

          for await (const frame of frames(lines(response.body, controller.signal))) {
            if (this.#closed) return;
            const event = parseSessionEvent(JSON.parse(frame.data) as unknown);
            const key = `${event.session_id}:${event.seq}`;
            if (this.#seen.has(key)) continue;
            this.#seen.add(key);
            this.#cursor = Math.max(this.#cursor, event.seq);
            failures = 0;
            yield event;
          }
        } catch (error) {
          if (this.#closed) return;
          if (
            !(error instanceof APIConnectionError) &&
            !(error instanceof APITimeoutError) &&
            !(error instanceof TypeError) &&
            !isAbortError(error)
          ) {
            throw error;
          }
        } finally {
          closeConnection?.();
          if (this.#controller === controller) this.#controller = undefined;
        }

        if (!this.#closed) {
          failures += 1;
          await sleep(retryDelay(undefined, failures - 1));
        }
      }
    } finally {
      this.close();
    }
  }
}
