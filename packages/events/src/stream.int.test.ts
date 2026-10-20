import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { runEventsKey } from './keys.js';
import { createEventBus, type EventBus, type EventBusMetrics } from './stream.js';

import type { SubscriptionItem } from './buffer.js';
import type { RunEvent } from '@blackwing/contracts';
import type { Redis } from 'ioredis';

let valkey: ValkeyHandle | undefined;
let redis: Redis;

beforeAll(async () => {
  valkey = await withValkey();
  redis = valkey.createClient();
});
afterAll(async () => {
  await valkey?.stop();
});
surfaceContainerLogsOnFailure(() => [valkey]);

const uid = (): string => randomBytes(6).toString('hex');

function makeEvent(seq: number, extra: Record<string, unknown> = {}): RunEvent {
  return {
    type: 'message.partial',
    ts: new Date(1_700_000_000_000 + seq).toISOString(),
    seq,
    payload: { n: seq, ...extra },
  };
}

function newBus(overrides: Partial<Parameters<typeof createEventBus>[0]> = {}): EventBus {
  return createEventBus({ redis, tenantId: `t${uid()}`, blockMs: 200, ...overrides });
}

/** Collects `count` items (any kind) from an iterator, failing if they take too long. */
async function take(
  iterator: AsyncIterator<SubscriptionItem>,
  count: number,
  timeoutMs = 10_000,
): Promise<SubscriptionItem[]> {
  const items: SubscriptionItem[] = [];
  const deadline = Date.now() + timeoutMs;
  while (items.length < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(`timed out after ${String(items.length)}/${String(count)} items`);
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`timed out after ${String(items.length)}/${String(count)} items`));
        }, remaining);
      }),
    ]);
    if (next.done === true) break;
    items.push(next.value);
  }
  return items;
}

const seqs = (items: SubscriptionItem[]): number[] =>
  items.flatMap((i) => (i.kind === 'event' ? [i.event.seq] : []));

describe('publish and subscribe', () => {
  it('delivers published events in order', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const sub = bus.subscribe(run, { fromId: '0' });
    const first = sub.next(); // start the subscription before publishing
    for (let n = 1; n <= 20; n += 1) await bus.publish(run, makeEvent(n));
    const rest = await take(sub, 19);
    const got = await first;
    expect(got.done).toBe(false);
    expect(
      [...(got.done === true ? [] : [got.value]), ...rest].map((i) =>
        i.kind === 'event' ? i.event.seq : -1,
      ),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await sub.return?.();
  });

  it('only delivers new events for "$" and everything for "0"', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    await bus.publish(run, makeEvent(1));
    await bus.publish(run, makeEvent(2));
    const fresh = bus.subscribe(run, { fromId: '$' });
    const all = bus.subscribe(run, { fromId: '0' });
    expect(seqs(await take(all, 2))).toEqual([1, 2]);
    const pending = take(fresh, 1);
    await new Promise((r) => setTimeout(r, 300));
    await bus.publish(run, makeEvent(3));
    expect(seqs(await pending)).toEqual([3]);
    await fresh.return?.();
    await all.return?.();
  });

  it('round-trips unicode payloads', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const text = 'héllo €uro 日本語 😀';
    await bus.publish(run, makeEvent(1, { text }));
    const [item] = await take(bus.subscribe(run, { fromId: '0' }), 1);
    expect(item?.kind === 'event' && item.event.payload.text).toBe(text);
  });

  it('sorts by stream id when several publishers send out-of-order seq', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const ids = [];
    for (const seq of [5, 3, 9, 1]) ids.push(await bus.publish(run, makeEvent(seq)));
    const sub = bus.subscribe(run, { fromId: '0' });
    const items = await take(sub, 4);
    expect(items.map((i) => (i.kind === 'event' ? i.id : ''))).toEqual(ids);
    expect(seqs(items)).toEqual([5, 3, 9, 1]);
    await sub.return?.();
  });

  it('stops promptly when the subscriber returns while blocked', async () => {
    const bus = newBus({ blockMs: 5_000 });
    const run = `r${uid()}`;
    const sub = bus.subscribe(run, { fromId: '$' });
    const pending = sub.next();
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    await sub.return?.();
    expect((await pending).done).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops on abort', async () => {
    const bus = newBus({ blockMs: 5_000 });
    const controller = new AbortController();
    const sub = bus.subscribe(`r${uid()}`, { signal: controller.signal });
    const pending = sub.next();
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    expect((await pending).done).toBe(true);
  });
});

describe('resume', () => {
  it('resumes from the last seen id without missing or duplicating events', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    for (let n = 1; n <= 5; n += 1) await bus.publish(run, makeEvent(n));
    const first = bus.subscribe(run, { fromId: '0' });
    const seen = await take(first, 3);
    const lastId = seen[2]?.kind === 'event' ? seen[2].id : '';
    await first.return?.(); // disconnect
    for (let n = 6; n <= 8; n += 1) await bus.publish(run, makeEvent(n));
    const second = bus.subscribe(run, { fromId: lastId });
    const resumed = await take(second, 5);
    expect([...seqs(seen), ...seqs(resumed)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(resumed.some((i) => i.kind !== 'event')).toBe(false);
    await second.return?.();
  });

  it('signals truncated when the cursor was trimmed away', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const ids: string[] = [];
    for (let n = 1; n <= 10; n += 1) ids.push(await bus.publish(run, makeEvent(n)));
    expect(await bus.trim(run, { maxLen: 3 })).toBe(7);
    const sub = bus.subscribe(run, { fromId: ids[1] ?? '' });
    const items = await take(sub, 4);
    expect(items[0]).toEqual({ kind: 'truncated', reason: 'trimmed', requestedId: ids[1] });
    expect(seqs(items)).toEqual([8, 9, 10]);
    await sub.return?.();
  });

  it('does not signal truncated when the cursor is the newest retained or trimmed entries are older', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const ids: string[] = [];
    for (let n = 1; n <= 6; n += 1) ids.push(await bus.publish(run, makeEvent(n)));
    await bus.trim(run, { maxLen: 3 }); // drops 1-3
    const sub = bus.subscribe(run, { fromId: ids[3] ?? '' }); // last event seen was #4: nothing missed
    expect(seqs(await take(sub, 2))).toEqual([5, 6]);
    await sub.return?.();
  });

  it('signals stream_missing after the stream is lost and then delivers new events', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    const id = await bus.publish(run, makeEvent(1));
    await bus.remove(run); // simulates a Valkey restart losing the data
    const sub = bus.subscribe(run, { fromId: id });
    const pending = take(sub, 2);
    await new Promise((r) => setTimeout(r, 300));
    await bus.publish(run, makeEvent(2));
    const items = await pending;
    expect(items[0]).toEqual({ kind: 'truncated', reason: 'stream_missing', requestedId: id });
    expect(seqs(items)).toEqual([2]);
    await sub.return?.();
  });
});

describe('retention', () => {
  it('keeps the stream bounded under load with MAXLEN ~', async () => {
    const metrics: number[] = [];
    const types: string[] = [];
    const sink: EventBusMetrics = {
      eventPublished: (type) => types.push(type),
      streamLength: (_run, length) => metrics.push(length),
      subscriberLag: () => undefined,
    };
    const bus = newBus({ maxLen: 100, metrics: sink });
    const run = `r${uid()}`;
    await Promise.all(Array.from({ length: 1_500 }, (_, n) => bus.publish(run, makeEvent(n))));
    const length = await redis.xlen(runEventsKey(bus.tenantId, run));
    expect(length).toBeGreaterThanOrEqual(100);
    expect(length).toBeLessThan(400);
    expect(Math.max(...metrics)).toBeLessThan(1_500);
    expect(types).toHaveLength(1_500);
  });

  it('sets a TTL, supports expire() and remove()', async () => {
    const bus = newBus({ ttlSeconds: 600 });
    const run = `r${uid()}`;
    await bus.publish(run, makeEvent(1));
    const key = runEventsKey(bus.tenantId, run);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    expect(await bus.expire(run, 30)).toBe(true);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(30);
    expect(await bus.remove(run)).toBe(true);
    expect(await redis.exists(key)).toBe(0);
  });
});

describe('tenant and run isolation', () => {
  it("never delivers another tenant's or another run's events", async () => {
    const tenantA = newBus();
    const tenantB = newBus();
    const run = `r${uid()}`;
    await tenantA.publish(run, makeEvent(1, { who: 'a' }));
    await tenantA.publish(`other${uid()}`, makeEvent(2));
    const sameRunOtherTenant = tenantB.subscribe(run, { fromId: '0' });
    const otherRun = tenantA.subscribe(`empty${uid()}`, { fromId: '0' });
    const first = sameRunOtherTenant.next();
    const second = otherRun.next();
    const winner = await Promise.race([
      first.then(() => 'delivered'),
      second.then(() => 'delivered'),
      new Promise<string>((r) =>
        setTimeout(() => {
          r('nothing');
        }, 1_000),
      ),
    ]);
    expect(winner).toBe('nothing');
    await sameRunOtherTenant.return?.();
    await otherRun.return?.();
    expect(runEventsKey(tenantA.tenantId, run)).not.toBe(runEventsKey(tenantB.tenantId, run));
  });

  it('refuses ids that would escape the key scope', async () => {
    const bus = newBus();
    await expect(bus.publish('x:y', makeEvent(1))).rejects.toThrow();
    await expect(bus.publish('*', makeEvent(1))).rejects.toThrow();
    expect(() => bus.subscribe('a:b')).toThrow();
  });
});

describe('backpressure', () => {
  it('bounds the buffer and emits a gap marker for a slow consumer', async () => {
    const lags: number[] = [];
    const bus = newBus({
      metrics: {
        eventPublished: () => undefined,
        streamLength: () => undefined,
        subscriberLag: (_r, l) => lags.push(l),
      },
    });
    const run = `r${uid()}`;
    for (let n = 1; n <= 60; n += 1) await bus.publish(run, makeEvent(n));
    const sub = bus.subscribe(run, { fromId: '0', bufferSize: 5 });
    const first = await take(sub, 1);
    await new Promise((r) => setTimeout(r, 300)); // consumer stalls while the reader fills the buffer
    const rest = await take(sub, 5);
    const all = [...first, ...rest];
    const gap = all.find((i) => i.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap?.kind === 'gap' && gap.dropped).toBeGreaterThan(0);
    expect(seqs(all).at(-1)).toBe(60);
    expect(Math.max(...lags)).toBeLessThanOrEqual(5);
    await sub.return?.();
  });
});

describe('consumer groups', () => {
  it('acknowledges, and redelivers unacknowledged entries (at-least-once)', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    for (let n = 1; n <= 4; n += 1) await bus.publish(run, makeEvent(n));

    const a = bus.consume(run, { group: 'archiver', consumer: 'c1', batchSize: 10 });
    const delivered: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = await a.next();
      if (next.done === true) throw new Error('ended early');
      delivered.push(next.value.event.seq);
      if (next.value.event.seq <= 2) await next.value.ack();
    }
    await a.return?.();
    expect(delivered).toEqual([1, 2, 3, 4]);

    // A restarted consumer with the same name gets the unacknowledged 3 and 4 again, not 1 and 2.
    const b = bus.consume(run, { group: 'archiver', consumer: 'c1' });
    const redelivered: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const next = await b.next();
      if (next.done === true) throw new Error('ended early');
      redelivered.push(next.value.event.seq);
      await next.value.ack();
    }
    expect(redelivered).toEqual([3, 4]);

    // New events flow after the backlog.
    const live = b.next();
    await bus.publish(run, makeEvent(5));
    const got = await live;
    expect(got.done === false && got.value.event.seq).toBe(5);
    await b.return?.();
    const pending = await redis.xpending(runEventsKey(bus.tenantId, run), 'archiver');
    expect(pending[0]).toBe(1); // only event 5 is still unacknowledged
  });

  it('recreates the group when the stream is lost (NOGROUP)', async () => {
    const bus = newBus();
    const run = `r${uid()}`;
    await bus.publish(run, makeEvent(1));
    const it = bus.consume(run, { group: 'g', consumer: 'c' });
    const first = await it.next();
    expect(first.done === false && first.value.event.seq).toBe(1);
    await bus.remove(run);
    const next = it.next();
    await new Promise((r) => setTimeout(r, 400));
    await bus.publish(run, makeEvent(2));
    const got = await Promise.race([
      next,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error('no recovery'));
        }, 8_000),
      ),
    ]);
    expect(got.done === false && got.value.event.seq).toBe(2);
    await it.return?.();
  });

  it('keeps groups tenant scoped', async () => {
    const a = newBus();
    const b = newBus();
    const run = `r${uid()}`;
    await a.publish(run, makeEvent(1));
    const it = b.consume(run, { group: 'g', consumer: 'c' });
    const winner = await Promise.race([
      it.next().then(() => 'delivered'),
      new Promise<string>((r) =>
        setTimeout(() => {
          r('nothing');
        }, 800),
      ),
    ]);
    expect(winner).toBe('nothing');
    await it.return?.();
  });
});
