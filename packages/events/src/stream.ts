import { SpanStatusCode, trace } from '@opentelemetry/api';

import { type RunEvent, runEventSchema } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { DropOldestBuffer, type SubscriptionItem, type TruncatedMarker } from './buffer.js';
import {
  assertSegment,
  assertTenantSegment,
  compareStreamIds,
  parseStreamId,
  runEventsKey,
} from './keys.js';

import type { Logger } from '@blackwing/logger';
import type { Redis } from 'ioredis';

/** Default approximate stream length cap (`EVENTS_STREAM_MAXLEN`). */
export const DEFAULT_STREAM_MAXLEN = 10_000;
/** Default cap on a serialised event (32 KiB); large blobs travel by reference. */
export const DEFAULT_MAX_EVENT_BYTES = 32_768;
/** Default stream retention after the last publish: events are ephemeral. */
export const DEFAULT_STREAM_TTL_SECONDS = 86_400;
/** Default per-subscriber buffer (events). */
export const DEFAULT_SUBSCRIBER_BUFFER = 1_000;
/** Default `XREAD BLOCK` window; short enough that a closed subscriber is noticed promptly. */
export const DEFAULT_BLOCK_MS = 2_000;
/** Default entries fetched per read. */
export const DEFAULT_BATCH_SIZE = 100;

const FIELD = 'e';
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 2_000;
const tracer = trace.getTracer('@blackwing/events');

/** Metric hooks (OBS wires these to Prometheus; the default is a no-op). */
export interface EventBusMetrics {
  /** `run_events_published_total{type}` */
  eventPublished(type: string): void;
  /** `run_event_stream_len{runId}` (sampled on publish). */
  streamLength(runId: string, length: number): void;
  /** `run_event_subscriber_lag`: events buffered for a subscriber and not yet consumed. */
  subscriberLag(runId: string, lag: number): void;
}

const NOOP_METRICS: EventBusMetrics = {
  eventPublished: () => undefined,
  streamLength: () => undefined,
  subscriberLag: () => undefined,
};

/** Options for {@link createEventBus}. */
export interface EventBusOptions {
  /** ioredis client for commands. Subscribers use a dedicated `duplicate()` of it. */
  readonly redis: Redis;
  /** Tenant the bus is bound to; it forms the key prefix and cannot be changed per call. */
  readonly tenantId: string;
  /** `MAXLEN ~` cap (default {@link DEFAULT_STREAM_MAXLEN}). */
  readonly maxLen?: number;
  /** Largest serialised event in bytes (default {@link DEFAULT_MAX_EVENT_BYTES}). */
  readonly maxEventBytes?: number;
  /** Stream TTL refreshed on every publish (default one day). */
  readonly ttlSeconds?: number;
  /** Default per-subscriber buffer capacity. */
  readonly subscriberBuffer?: number;
  /** Default `XREAD BLOCK` window in milliseconds. */
  readonly blockMs?: number;
  readonly metrics?: EventBusMetrics;
  readonly logger?: Logger;
  /** Creates the dedicated blocking connection; defaults to `redis.duplicate()`. */
  readonly createBlockingConnection?: () => Redis;
}

export interface SubscribeOptions {
  /**
   * Resume cursor. `'$'` (default) only new events, `'0'` from the start, otherwise the last stream
   * id seen: the subscriber receives every event after it, no gaps and no duplicates.
   */
  readonly fromId?: string;
  /** Per-subscriber buffer capacity (events); overflow drops the oldest and emits a gap marker. */
  readonly bufferSize?: number;
  readonly signal?: AbortSignal;
}

export interface ConsumeOptions {
  readonly group: string;
  readonly consumer: string;
  /** Where a new group starts: `'0'` (default, everything retained) or `'$'`. */
  readonly startId?: '0' | '$';
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
}

/** An event delivered to a consumer-group member; `ack` after it is durably handled. */
export interface GroupEvent {
  readonly kind: 'event';
  readonly id: string;
  readonly event: RunEvent;
  ack(): Promise<void>;
}

export interface EventBus {
  readonly tenantId: string;
  /** Appends a validated event and returns its stream id. */
  publish(runId: string, event: RunEvent): Promise<string>;
  /** Resumable live subscription (own connection; ends on `return()`, `break` or abort). */
  subscribe(runId: string, options?: SubscribeOptions): AsyncIterableIterator<SubscriptionItem>;
  /** At-least-once consumption through a consumer group (pending entries are redelivered first). */
  consume(runId: string, options: ConsumeOptions): AsyncIterableIterator<GroupEvent>;
  /** Acknowledges group deliveries. */
  ack(runId: string, group: string, ...ids: string[]): Promise<number>;
  /** Trims to the newest `maxLen` entries (exact; default the configured cap). Returns the deleted count. */
  trim(runId: string, options?: { readonly maxLen?: number }): Promise<number>;
  /** Sets the stream to expire after `seconds` (retention after the run finishes). */
  expire(runId: string, seconds: number): Promise<boolean>;
  /** Removes the run's stream entirely. */
  remove(runId: string): Promise<boolean>;
}

function positiveInt(label: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawEntry {
  readonly id: string;
  readonly fields: readonly string[] | null;
}

/** Flattens an `XREAD`/`XREADGROUP` reply for the single stream asked for. */
function parseReadReply(reply: unknown): RawEntry[] {
  if (!Array.isArray(reply)) return [];
  const entries: RawEntry[] = [];
  for (const stream of reply as unknown[]) {
    if (!Array.isArray(stream)) continue;
    const list: unknown = stream[1];
    if (!Array.isArray(list)) continue;
    for (const item of list as unknown[]) {
      if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
      const fields: unknown = item[1];
      entries.push({
        id: item[0],
        fields:
          Array.isArray(fields) && fields.every((f): f is string => typeof f === 'string')
            ? fields
            : null,
      });
    }
  }
  return entries;
}

function decodeEntry(entry: RawEntry): RunEvent | undefined {
  if (entry.fields === null) return undefined;
  for (let i = 0; i + 1 < entry.fields.length; i += 2) {
    if (entry.fields[i] !== FIELD) continue;
    try {
      const parsed = runEventSchema.safeParse(JSON.parse(entry.fields[i + 1] ?? ''));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Newest generated id and oldest retained id from an `XINFO STREAM` reply. */
function streamBounds(reply: unknown): { last: string | undefined; first: string | undefined } {
  let last: string | undefined;
  let first: string | undefined;
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) {
      const value: unknown = reply[i + 1];
      if (reply[i] === 'last-generated-id' && typeof value === 'string') last = value;
      if (reply[i] === 'first-entry' && Array.isArray(value) && typeof value[0] === 'string') {
        first = value[0];
      }
    }
  }
  return { last, first };
}

function isNoSuchKey(error: unknown): boolean {
  return error instanceof Error && /no such key/i.test(error.message);
}

function isNoGroup(error: unknown): boolean {
  return error instanceof Error && error.message.includes('NOGROUP');
}

/**
 * Wraps a generator so `return()` first runs `close()`. A bare async generator queues `return()`
 * behind a pending `next()` that is blocked on Valkey; closing first unblocks it, so unsubscribing
 * releases the dedicated connection immediately.
 */
function withEagerReturn<T>(
  inner: AsyncGenerator<T, void, undefined>,
  close: () => void,
): AsyncIterableIterator<T> {
  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => inner.next(),
    return: () => {
      close();
      return inner.return(undefined);
    },
    throw: (error: unknown) => {
      close();
      return inner.throw(error);
    },
  };
  return iterator;
}

/** Creates the Redis Streams event bus for one tenant (Valkey). */
export function createEventBus(options: EventBusOptions): EventBus {
  const tenantId = assertTenantSegment(options.tenantId);
  const redis = options.redis;
  const maxLen = positiveInt('maxLen', options.maxLen, DEFAULT_STREAM_MAXLEN);
  const maxEventBytes = positiveInt(
    'maxEventBytes',
    options.maxEventBytes,
    DEFAULT_MAX_EVENT_BYTES,
  );
  const ttlSeconds = positiveInt('ttlSeconds', options.ttlSeconds, DEFAULT_STREAM_TTL_SECONDS);
  const defaultBuffer = positiveInt(
    'subscriberBuffer',
    options.subscriberBuffer,
    DEFAULT_SUBSCRIBER_BUFFER,
  );
  const blockMs = positiveInt('blockMs', options.blockMs, DEFAULT_BLOCK_MS);
  const metrics = options.metrics ?? NOOP_METRICS;
  const logger = options.logger;
  const openConnection = options.createBlockingConnection ?? ((): Redis => redis.duplicate());

  const keyFor = (runId: string): string => runEventsKey(tenantId, runId);

  async function publish(runId: string, event: RunEvent): Promise<string> {
    const key = keyFor(runId);
    return tracer.startActiveSpan('events.publish', async (span) => {
      span.setAttributes({ 'bw.tenant_id': tenantId, 'bw.run_id': runId });
      try {
        const parsed = runEventSchema.safeParse(event);
        if (!parsed.success) {
          // Issue paths only: never echo payload values (they could carry customer data).
          const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
          throw new ValidationError(`invalid run event: ${paths}`);
        }
        const data = JSON.stringify(parsed.data);
        const bytes = Buffer.byteLength(data, 'utf8');
        if (bytes > maxEventBytes) {
          throw new ValidationError(
            `run event is ${String(bytes)} bytes, over the ${String(maxEventBytes)} byte cap; pass large blobs by reference`,
          );
        }
        span.setAttribute('bw.event_type', parsed.data.type);
        const results = await redis
          .pipeline()
          .xadd(key, 'MAXLEN', '~', maxLen, '*', FIELD, data)
          .xlen(key)
          .expire(key, ttlSeconds)
          .exec();
        const [added, length] = results ?? [];
        if (added?.[0] !== null) {
          throw added?.[0] ?? new Error('XADD returned no result');
        }
        const id = String(added[1]);
        metrics.eventPublished(parsed.data.type);
        if (length?.[0] === null && typeof length[1] === 'number') {
          metrics.streamLength(runId, length[1]);
        }
        logger?.debug({ tenantId, runId, type: parsed.data.type, id }, 'run event published');
        return id;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** Resolves the caller's cursor to a concrete id and reports a cursor that fell off the stream. */
  async function resolveStart(
    key: string,
    fromId: string,
  ): Promise<{ cursor: string; truncated?: TruncatedMarker }> {
    if (fromId === '$') {
      const latest = await redis.xrevrange(key, '+', '-', 'COUNT', 1);
      const id = latest[0]?.[0];
      return { cursor: id ?? '0-0' };
    }
    if (fromId === '0') return { cursor: '0-0' };
    const requested = parseStreamId(fromId);
    if (requested === undefined) {
      throw new ValidationError('fromId must be "$", "0" or a stream id such as 1700000000000-0');
    }
    try {
      // XTRIM does not record what it removed, so judge by position: when newer events exist but the
      // oldest retained entry is already past the cursor, the entries in between are gone. This can
      // over-report by one (the cursor itself was the last entry trimmed), which only costs a refetch.
      const { last, first } = streamBounds(await redis.xinfo('STREAM', key));
      const newest = parseStreamId(last ?? '0-0');
      const oldest = first === undefined ? undefined : parseStreamId(first);
      const hasNewer = newest !== undefined && compareStreamIds(newest, requested) > 0;
      if (hasNewer && (oldest === undefined || compareStreamIds(oldest, requested) > 0)) {
        return {
          cursor: fromId,
          truncated: { kind: 'truncated', reason: 'trimmed', requestedId: fromId },
        };
      }
      return { cursor: fromId };
    } catch (error) {
      if (!isNoSuchKey(error)) throw error;
      // The stream is gone (Valkey restart / expiry): everything now in it is new to this client.
      return {
        cursor: '0-0',
        truncated: { kind: 'truncated', reason: 'stream_missing', requestedId: fromId },
      };
    }
  }

  function subscribe(
    runId: string,
    subscribeOptions: SubscribeOptions = {},
  ): AsyncIterableIterator<SubscriptionItem> {
    const key = keyFor(runId);
    const fromId = subscribeOptions.fromId ?? '$';
    if (fromId !== '$' && fromId !== '0' && parseStreamId(fromId) === undefined) {
      throw new ValidationError('fromId must be "$", "0" or a stream id such as 1700000000000-0');
    }
    const capacity = positiveInt('bufferSize', subscribeOptions.bufferSize, defaultBuffer);
    const signal = subscribeOptions.signal;
    const buffer = new DropOldestBuffer(capacity);

    let closed = false;
    const isClosed = (): boolean => closed;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let connection: Redis | undefined;

    const notify = (): void => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const close = (): void => {
      closed = true;
      // Disconnecting interrupts a pending XREAD BLOCK so the dedicated connection is released.
      connection?.disconnect();
      notify();
    };
    if (signal?.aborted === true) closed = true;
    signal?.addEventListener('abort', close, { once: true });

    async function run(): Promise<void> {
      let delay = RETRY_MIN_MS;
      let cursor = '0-0';
      let started = false;
      while (!isClosed()) {
        try {
          if (!started) {
            const start = await resolveStart(key, fromId);
            cursor = start.cursor;
            if (start.truncated !== undefined) buffer.pushMarker(start.truncated);
            started = true;
            notify();
          }
          connection ??= openConnection();
          const reply: unknown = await connection.xread(
            'COUNT',
            DEFAULT_BATCH_SIZE,
            'BLOCK',
            blockMs,
            'STREAMS',
            key,
            cursor,
          );
          delay = RETRY_MIN_MS;
          for (const entry of parseReadReply(reply)) {
            cursor = entry.id;
            const event = decodeEntry(entry);
            if (event === undefined) {
              logger?.warn({ tenantId, runId, id: entry.id }, 'skipped malformed run event');
              continue;
            }
            buffer.push({ kind: 'event', id: entry.id, event });
          }
          metrics.subscriberLag(runId, buffer.size);
          notify();
        } catch (error) {
          if (isClosed()) break;
          if (!started && error instanceof ValidationError) {
            failure = error;
            break;
          }
          logger?.warn(
            { tenantId, runId, err: errorMessage(error) },
            'event subscription read failed; retrying',
          );
          connection?.disconnect();
          connection = undefined;
          await sleep(delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
      notify();
    }

    async function* iterate(): AsyncGenerator<SubscriptionItem, void, undefined> {
      const pump = run();
      try {
        for (;;) {
          const item = buffer.shift();
          if (item !== undefined) {
            yield item;
            continue;
          }
          if (failure !== undefined) throw failure;
          if (isClosed()) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            // A close or item that raced in before the waiter was installed must not be lost.
            if (isClosed() || !buffer.isEmpty || failure !== undefined) notify();
          });
        }
      } finally {
        signal?.removeEventListener('abort', close);
        close();
        await pump.catch(() => undefined);
      }
    }

    return withEagerReturn(iterate(), close);
  }

  async function ensureGroup(key: string, group: string, startId: '0' | '$'): Promise<void> {
    try {
      await redis.xgroup('CREATE', key, group, startId, 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('BUSYGROUP'))) throw error;
    }
  }

  function consume(
    runId: string,
    consumeOptions: ConsumeOptions,
  ): AsyncIterableIterator<GroupEvent> {
    const key = keyFor(runId);
    const { group, consumer } = consumeOptions;
    assertSegment('group', group);
    assertSegment('consumer', consumer);
    const startId = consumeOptions.startId ?? '0';
    const batch = positiveInt('batchSize', consumeOptions.batchSize, DEFAULT_BATCH_SIZE);
    const signal = consumeOptions.signal;
    let connection: Redis | undefined;
    let closed = signal?.aborted === true;
    const isClosed = (): boolean => closed;
    const close = (): void => {
      closed = true;
      connection?.disconnect();
    };
    signal?.addEventListener('abort', close, { once: true });

    async function* iterate(): AsyncGenerator<GroupEvent, void, undefined> {
      let pending = true; // redeliver this consumer's unacknowledged entries first
      let delay = RETRY_MIN_MS;
      try {
        while (!isClosed()) {
          try {
            await ensureGroup(key, group, startId);
            connection ??= openConnection();
            const reply: unknown = pending
              ? await connection.xreadgroup(
                  'GROUP',
                  group,
                  consumer,
                  'COUNT',
                  batch,
                  'STREAMS',
                  key,
                  '0',
                )
              : await connection.xreadgroup(
                  'GROUP',
                  group,
                  consumer,
                  'COUNT',
                  batch,
                  'BLOCK',
                  blockMs,
                  'STREAMS',
                  key,
                  '>',
                );
            delay = RETRY_MIN_MS;
            const entries = parseReadReply(reply);
            if (pending && entries.length === 0) pending = false;
            for (const entry of entries) {
              const event = decodeEntry(entry);
              if (event === undefined) {
                // Deleted-by-trim or malformed: acknowledge so it is not redelivered forever.
                logger?.warn({ tenantId, runId, id: entry.id }, 'dropped unreadable group entry');
                await redis.xack(key, group, entry.id);
                continue;
              }
              yield {
                kind: 'event',
                id: entry.id,
                event,
                ack: () => ack(runId, group, entry.id).then(() => undefined),
              };
            }
          } catch (error) {
            if (isClosed()) break;
            // NOGROUP: the stream/group vanished (Valkey restart). Recreate and carry on.
            if (!isNoGroup(error)) {
              logger?.warn(
                { tenantId, runId, err: errorMessage(error) },
                'event group read failed; retrying',
              );
              connection?.disconnect();
              connection = undefined;
              await sleep(delay);
              delay = Math.min(delay * 2, RETRY_MAX_MS);
            }
            pending = true;
          }
        }
      } finally {
        signal?.removeEventListener('abort', close);
        close();
      }
    }

    return withEagerReturn(iterate(), close);
  }

  async function ack(runId: string, group: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return redis.xack(keyFor(runId), group, ...ids);
  }

  async function trim(
    runId: string,
    trimOptions: { readonly maxLen?: number } = {},
  ): Promise<number> {
    const length = trimOptions.maxLen ?? maxLen;
    if (!Number.isInteger(length) || length < 0) {
      throw new ValidationError('maxLen must be a non-negative integer');
    }
    return redis.xtrim(keyFor(runId), 'MAXLEN', length);
  }

  async function expire(runId: string, seconds: number): Promise<boolean> {
    return (await redis.expire(keyFor(runId), positiveInt('seconds', seconds, 1))) === 1;
  }

  async function remove(runId: string): Promise<boolean> {
    return (await redis.del(keyFor(runId))) === 1;
  }

  return { tenantId, publish, subscribe, consume, ack, trim, expire, remove };
}
