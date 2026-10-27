'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { type RunEvent, runEventSchema } from '@blackwing/contracts';

/** `NEXT_PUBLIC_*` is inlined only for literal `process.env.NAME` reads, so each key is read explicitly. */
function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_CLIENT_BUFFER = 2_000;
/** Server caps events at 32 KiB; anything far beyond that is dropped unparsed. */
export const MAX_EVENT_CHARS = 65_536;

/** Caps the exponent so `2 ** attempt` cannot overflow to Infinity. */
const MAX_BACKOFF_EXPONENT = 30;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
/** Event types the server uses to say the cursor was trimmed / the run stream has ended. */
const TRUNCATED_TYPE = 'stream.truncated';
const CLOSED_TYPE = 'stream.closed';
/** `EventSource.CLOSED`; the constant is not defined by every test double. */
const READY_STATE_CLOSED = 2;

type RunEventStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'truncated';

/** An event with the SSE `id:` it arrived under; the id (not the client clock) defines order. */
interface StreamedRunEvent {
  readonly id: string;
  readonly event: RunEvent;
}

/** Minimal `EventSource` surface the hook uses (test seam). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export interface RunEventStreamOptions {
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /** Ring buffer capacity (`SSE_CLIENT_BUFFER`). */
  readonly bufferSize?: number;
  /** Test seams. */
  readonly createEventSource?: (url: string) => EventSourceLike;
  readonly probe?: (url: string) => Promise<number | undefined>;
  readonly random?: () => number;
  /** Receives `{runId, lastEventId}` only, never event payloads. */
  readonly log?: (
    name: 'sse_reconnect' | 'sse_truncated',
    ids: { runId: string; lastEventId: string | undefined },
  ) => void;
}

export interface RunEventStream {
  readonly events: readonly StreamedRunEvent[];
  readonly status: RunEventStreamStatus;
  readonly lastEventId: string | undefined;
  /** True once the oldest events were dropped from the buffer ("earlier activity trimmed"). */
  readonly gap: boolean;
  /** True when the BFF/API refused the run (403/404): surface forbidden, do not retry. */
  readonly forbidden: boolean;
  readonly reconnects: number;
  readonly invalidEvents: number;
  readonly droppedEvents: number;
  /** Restarts the stream (after a refetch following `truncated`, or after `closed`). */
  readonly reconnect: () => void;
}

/** Stream ids are `<ms>-<seq>`; compares numerically, returns NaN-free -1/0/1 (unknown shapes sort equal). */
export function compareEventIds(a: string, b: string): number {
  const [am = '', as = '0'] = a.split('-');
  const [bm = '', bs = '0'] = b.split('-');
  const pairs: [string, string][] = [
    [am, bm],
    [as, bs],
  ];
  for (const [x, y] of pairs) {
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Full-jitter backoff: `min(max, base * 2^attempt)`, randomised into its upper half. */
export function backoffDelayMs(attempt: number, base: number, max: number, rand: number): number {
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, MAX_BACKOFF_EXPONENT));
  return Math.floor(ceiling / 2 + (rand * ceiling) / 2);
}

async function defaultProbe(url: string): Promise<number | undefined> {
  const controller = new AbortController();
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    controller.abort();
    return res.status;
  } catch {
    return undefined;
  }
}

interface Snapshot {
  reconnects: number;
  invalidEvents: number;
  droppedEvents: number;
  events: readonly StreamedRunEvent[];
  status: RunEventStreamStatus;
  lastEventId: string | undefined;
  gap: boolean;
  forbidden: boolean;
}

const INITIAL: Snapshot = {
  events: [],
  status: 'connecting',
  lastEventId: undefined,
  gap: false,
  forbidden: false,
  reconnects: 0,
  invalidEvents: 0,
  droppedEvents: 0,
};

export function useRunEventStream(runId: string, opts: RunEventStreamOptions = {}): RunEventStream {
  // The snapshot lives in a ref (it survives effect restarts, so a reconnect resumes) and a counter
  // re-renders on change. `owner` guards against showing a previous run's data after `runId` changes.
  const store = useRef<{ owner: string; snap: Snapshot }>({ owner: runId, snap: INITIAL });
  const [, rerender] = useState(0);
  const [generation, setGeneration] = useState(0);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const reconnect = useCallback(() => {
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    const o = optsRef.current;
    const base =
      o.reconnectBaseMs ??
      intFromEnv(process.env.NEXT_PUBLIC_SSE_RECONNECT_BASE_MS, DEFAULT_RECONNECT_BASE_MS);
    const max =
      o.reconnectMaxMs ??
      intFromEnv(process.env.NEXT_PUBLIC_SSE_RECONNECT_MAX_MS, DEFAULT_RECONNECT_MAX_MS);
    const capacity =
      o.bufferSize ?? intFromEnv(process.env.NEXT_PUBLIC_SSE_CLIENT_BUFFER, DEFAULT_CLIENT_BUFFER);
    const create = o.createEventSource ?? ((url: string): EventSourceLike => new EventSource(url));
    const probe = o.probe ?? defaultProbe;
    const random = o.random ?? Math.random;
    const log = o.log ?? (() => undefined);

    // A different run, or a truncated cursor, starts from scratch; otherwise resume from the cursor.
    if (store.current.owner !== runId || store.current.snap.status === 'truncated') {
      store.current = { owner: runId, snap: INITIAL };
    }
    const cursor = { lastEventId: store.current.snap.lastEventId };
    let disposed = false;
    let source: EventSourceLike | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let pending: StreamedRunEvent[] = [];
    let flushQueued = false;
    const publish = (patch: Partial<Snapshot>): void => {
      store.current = { owner: runId, snap: { ...store.current.snap, ...patch } };
      rerender((n) => n + 1);
    };
    publish({ status: 'connecting', forbidden: false });

    const flush = (): void => {
      flushQueued = false;
      if (disposed || pending.length === 0) return;
      let merged = [...store.current.snap.events, ...pending];
      pending = [];
      let dropped = 0;
      if (merged.length > capacity) {
        dropped = merged.length - capacity;
        merged = merged.slice(dropped);
      }
      publish({
        events: merged,
        lastEventId: cursor.lastEventId,
        ...(dropped > 0
          ? { gap: true, droppedEvents: store.current.snap.droppedEvents + dropped }
          : {}),
      });
    };

    const queueFlush = (): void => {
      if (!flushQueued) {
        flushQueued = true;
        queueMicrotask(flush);
      }
    };

    const bumpInvalid = (): void => {
      publish({ invalidEvents: store.current.snap.invalidEvents + 1 });
    };

    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (source) {
        source.onopen = null;
        source.onmessage = null;
        source.onerror = null;
        source.close();
      }
      source = undefined;
    };

    const finish = (status: 'closed' | 'truncated', extra: Partial<Snapshot> = {}): void => {
      flush();
      stop();
      publish({ status, ...extra });
    };

    const handle = (ev: MessageEvent<string>): void => {
      if (disposed) return;
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data.length === 0 || data.length > MAX_EVENT_CHARS) {
        bumpInvalid();
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        bumpInvalid();
        return;
      }
      const parsed = runEventSchema.safeParse(json);
      if (!parsed.success) {
        bumpInvalid();
        return;
      }
      const type = parsed.data.type;
      if (type === TRUNCATED_TYPE) {
        log('sse_truncated', { runId, lastEventId: cursor.lastEventId });
        finish('truncated');
        return;
      }
      if (type === CLOSED_TYPE) {
        finish('closed');
        return;
      }
      const id = ev.lastEventId;
      const last = cursor.lastEventId;
      if (!id || (last !== undefined && compareEventIds(id, last) <= 0)) {
        // Missing id cannot be ordered or resumed from; a replayed id is a duplicate.
        if (!id) bumpInvalid();
        return;
      }
      cursor.lastEventId = id;
      pending.push({ id, event: parsed.data });
      queueFlush();
    };

    const url = (): string => {
      const path = `/api/stream/runs/${encodeURIComponent(runId)}/events`;
      const last = cursor.lastEventId;
      return last === undefined ? path : `${path}?lastEventId=${encodeURIComponent(last)}`;
    };

    const scheduleReconnect = (): void => {
      const delay = backoffDelayMs(attempt, base, max, random());
      attempt += 1;
      log('sse_reconnect', { runId, lastEventId: cursor.lastEventId });
      publish({ status: 'reconnecting', reconnects: store.current.snap.reconnects + 1 });
      timer = setTimeout(connect, delay);
    };

    const onError = (fatal: boolean): void => {
      if (disposed) return;
      flush();
      const target = url();
      stop();
      if (!fatal) {
        scheduleReconnect();
        return;
      }
      // The browser gave up (HTTP error or wrong content type): find out why before retrying.
      publish({ status: 'reconnecting' });
      void probe(target).then((code) => {
        if (disposed) return;
        if (code === HTTP_UNAUTHORIZED || code === HTTP_FORBIDDEN || code === HTTP_NOT_FOUND) {
          finish('closed', { forbidden: true });
        } else if (code === HTTP_CONFLICT) {
          log('sse_truncated', { runId, lastEventId: cursor.lastEventId });
          finish('truncated');
        } else {
          scheduleReconnect();
        }
      });
    };

    function connect(): void {
      timer = undefined;
      if (disposed) return;
      const es = create(url());
      source = es;
      es.onopen = () => {
        attempt = 0;
        publish({ status: 'open' });
      };
      es.onmessage = handle;
      es.addEventListener(TRUNCATED_TYPE, handle);
      es.addEventListener(CLOSED_TYPE, handle);
      es.onerror = () => {
        onError(es.readyState === READY_STATE_CLOSED);
      };
    }

    connect();

    return () => {
      flush();
      disposed = true;
      stop();
    };
  }, [runId, generation]);

  const snap = store.current.owner === runId ? store.current.snap : INITIAL;
  return {
    events: snap.events,
    status: snap.status,
    lastEventId: snap.lastEventId,
    gap: snap.gap,
    forbidden: snap.forbidden,
    reconnects: snap.reconnects,
    invalidEvents: snap.invalidEvents,
    droppedEvents: snap.droppedEvents,
    reconnect,
  };
}
