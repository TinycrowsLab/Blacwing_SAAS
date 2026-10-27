import { ValidationError } from '@blackwing/errors';
import { parseStreamId } from '@blackwing/events';

import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

/** Response headers of every event stream. Buffering and transforms are switched off (#65). */
const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

const HTTP_OK = 200;

/** SSE field names are written verbatim, so a name must never carry a line break or a colon. */
const EVENT_NAME = /^[a-z][a-z0-9_.]{0,127}$/;

/**
 * Frame for one run event: `id:` is the stream entry id (the resume cursor), `event:` the run event type,
 * `data:` the JSON event. JSON never contains a raw line break, so one `data:` line is always enough.
 */
export function formatEventFrame(id: string, eventName: string, data: unknown): string {
  return `id: ${assertLine('id', id)}\n${controlFrame(eventName, data)}`;
}

/** Frame without an id (control frames: `state`, `resync`, `end`, `timeout`, `error`). */
export function formatControlFrame(eventName: string, data: unknown): string {
  return controlFrame(eventName, data);
}

/** Comment frame that keeps an idle connection alive through proxies. Clients ignore it. */
const HEARTBEAT_FRAME = ': heartbeat\n\n';

function controlFrame(eventName: string, data: unknown): string {
  if (!EVENT_NAME.test(eventName)) {
    throw new ValidationError(
      'an event name must be lower-case letters, digits, dots or underscores',
    );
  }
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function assertLine(label: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ValidationError(`${label} must be a single line`);
  return value;
}

/**
 * The resume cursor a client sent: the `Last-Event-ID` header (what `EventSource` sends on reconnect),
 * or the `lastEventId` query parameter (for clients that cannot set headers). Undefined means a fresh
 * stream. Anything that is not a concrete stream id is refused, never guessed at.
 */
export function resumeCursor(header: unknown, query: unknown): string | undefined {
  if (header !== undefined && typeof header !== 'string') {
    throw new ValidationError('Last-Event-ID must be a single stream id');
  }
  if (query !== undefined && typeof query !== 'string') {
    throw new ValidationError('lastEventId must be a single stream id');
  }
  const raw = header !== undefined && header !== '' ? header : query;
  if (raw === undefined || raw === '') return undefined;
  if (parseStreamId(raw) === undefined) {
    throw new ValidationError('Last-Event-ID must be a stream id such as 1700000000000-0');
  }
  return raw;
}

/** The frame writer the route drives. It owns the lifetime: heartbeat, max duration and disconnects. */
export interface SseStreamOptions {
  readonly heartbeatMs: number;
  readonly maxDurationMs: number;
  /** Runs once when the stream closes for any reason (the caller releases its connection slot here). */
  readonly onClose?: () => void;
}

/**
 * A Server-Sent Events response on a raw Node response (Fastify `reply.raw` after `reply.hijack()`).
 * Call it only after authentication and authorisation: once the headers are out, errors can only be
 * sent as frames. `signal` aborts when the stream closes, so a subscription bound to it stops with it.
 */
export class SseStream {
  readonly #raw: ServerResponse;
  readonly #controller = new AbortController();
  readonly #onClose: (() => void) | undefined;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #maxDuration: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(raw: ServerResponse, headers: OutgoingHttpHeaders, options: SseStreamOptions) {
    this.#raw = raw;
    this.#onClose = options.onClose;
    raw.writeHead(HTTP_OK, { ...headers, ...SSE_HEADERS });
    raw.flushHeaders();
    raw.once('close', () => {
      this.close();
    });
    this.#heartbeat = setInterval(() => {
      if (!this.#closed) raw.write(HEARTBEAT_FRAME);
    }, options.heartbeatMs);
    this.#maxDuration = setTimeout(() => {
      this.end(formatControlFrame('timeout', { reason: 'max_duration' }));
    }, options.maxDurationMs);
  }

  /** Aborts when the stream closes: client gone, ended by the server, or timed out. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Writes one frame, waiting for the socket to drain when it is full (backpressure). Resolves `false`
   * once the stream is closed, so the caller stops producing.
   */
  async send(frame: string): Promise<boolean> {
    if (this.#closed) return false;
    if (!this.#raw.write(frame)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.#raw.off('drain', done);
          this.#raw.off('close', done);
          resolve();
        };
        this.#raw.once('drain', done);
        this.#raw.once('close', done);
      });
    }
    return !this.#closed;
  }

  /** Writes an optional final frame, ends the response and closes the stream. Idempotent. */
  end(finalFrame?: string): void {
    if (this.#closed) return;
    if (finalFrame !== undefined) this.#raw.write(finalFrame);
    this.#raw.end();
    this.close();
  }

  /** Stops the timers and aborts the signal. Idempotent; runs `onClose` once. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#maxDuration);
    this.#controller.abort();
    this.#onClose?.();
  }
}
