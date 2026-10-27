import { describe, expect, it } from 'vitest';

import { runEventSchema } from '@blackwing/contracts';
import { TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { DropOldestBuffer, type StreamEvent } from './buffer.js';
import { compareStreamIds, parseStreamId, runEventsKey } from './keys.js';
import { createEventBus } from './stream.js';

import type { Redis } from 'ioredis';

const event = {
  type: 'message.partial',
  ts: '2026-01-01T00:00:00.000Z',
  seq: 1,
  payload: { text: 'hi' },
};

const fakeRedis = {} as unknown as Redis;

describe('runEventSchema', () => {
  it('accepts a valid event', () => {
    expect(runEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    ['unknown field', { ...event, extra: 1 }],
    ['bad type', { ...event, type: 'Not Valid' }],
    ['bad ts', { ...event, ts: 'yesterday' }],
    ['negative seq', { ...event, seq: -1 }],
    ['fractional seq', { ...event, seq: 1.5 }],
    ['array payload', { ...event, payload: [] }],
    ['missing payload', { type: event.type, ts: event.ts, seq: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(runEventSchema.safeParse(value).success).toBe(false);
  });
});

describe('runEventsKey', () => {
  it('builds the tenant and run scoped key', () => {
    expect(runEventsKey('tenant-a', 'run-1')).toBe('bw:tenant-a:run:run-1:events');
  });

  it.each(['a:b', 'a*', '', 'a b', '{x}', 'a'.repeat(65), '../x'])(
    'refuses the unsafe segment %j',
    (value) => {
      expect(() => runEventsKey('t', value)).toThrow(ValidationError);
      expect(() => runEventsKey(value, 'r')).toThrow();
    },
  );

  it('fails closed without a tenant', () => {
    expect(() => runEventsKey('', 'r')).toThrow(TenantContextMissingError);
    expect(() => createEventBus({ redis: fakeRedis, tenantId: '' })).toThrow(
      TenantContextMissingError,
    );
  });
});

describe('stream ids', () => {
  it('parses and orders ids', () => {
    const a = parseStreamId('10-2');
    const b = parseStreamId('10-10');
    expect(a && b && compareStreamIds(a, b)).toBeLessThan(0);
    expect(parseStreamId('7')).toEqual({ ms: 7n, seq: 0n });
    expect(parseStreamId('$')).toBeUndefined();
    expect(parseStreamId('1-2-3')).toBeUndefined();
  });
});

describe('DropOldestBuffer', () => {
  const item = (n: number): StreamEvent => ({
    kind: 'event',
    id: `${String(n)}-0`,
    event: { ...event, seq: n },
  });

  it('keeps order below capacity', () => {
    const buffer = new DropOldestBuffer(3);
    buffer.push(item(1));
    buffer.push(item(2));
    expect(buffer.shift()).toEqual(item(1));
    expect(buffer.shift()).toEqual(item(2));
    expect(buffer.shift()).toBeUndefined();
  });

  it('drops the oldest, bounds memory and reports one gap marker first', () => {
    const buffer = new DropOldestBuffer(2);
    for (let n = 1; n <= 10; n += 1) buffer.push(item(n));
    expect(buffer.size).toBe(2);
    expect(buffer.droppedTotal).toBe(8);
    expect(buffer.shift()).toEqual({ kind: 'gap', dropped: 8, fromId: '1-0', toId: '8-0' });
    expect(buffer.shift()).toEqual(item(9));
    expect(buffer.shift()).toEqual(item(10));
    expect(buffer.isEmpty).toBe(true);
  });

  it('delivers truncation markers before everything else and never drops them', () => {
    const buffer = new DropOldestBuffer(1);
    buffer.push(item(1));
    buffer.pushMarker({ kind: 'truncated', reason: 'trimmed', requestedId: '0-1' });
    buffer.push(item(2));
    expect(buffer.shift()?.kind).toBe('truncated');
    expect(buffer.shift()?.kind).toBe('gap');
    expect(buffer.shift()).toEqual(item(2));
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new DropOldestBuffer(0)).toThrow(RangeError);
  });
});

describe('publish validation', () => {
  const bus = createEventBus({ redis: fakeRedis, tenantId: 't1', maxEventBytes: 200 });

  it('rejects an invalid event without touching Redis and without echoing the payload', async () => {
    const error: unknown = await bus
      .publish('r1', { ...event, type: 'BAD', payload: { secret: 'hunter2' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('rejects an oversized payload (large blobs go by reference)', async () => {
    await expect(
      bus.publish('r1', { ...event, payload: { text: 'x'.repeat(500) } }),
    ).rejects.toThrow(/byte cap/);
  });

  it('counts multi-byte characters in bytes', async () => {
    await expect(
      bus.publish('r1', { ...event, payload: { text: '€'.repeat(80) } }),
    ).rejects.toThrow(/byte cap/);
  });

  it('refuses a cursor that is not a stream id', () => {
    expect(() => bus.subscribe('r1', { fromId: 'abc' })).toThrow(ValidationError);
  });

  it('refuses invalid options', () => {
    expect(() => createEventBus({ redis: fakeRedis, tenantId: 't', maxLen: 0 })).toThrow(
      ValidationError,
    );
  });
});

describe('countAfter', () => {
  it('counts entries strictly after the cursor, bounded by the limit', async () => {
    const calls: unknown[][] = [];
    const redis = {
      xrange: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve([
          ['2-0', []],
          ['3-0', []],
        ]);
      },
    } as unknown as Redis;
    const bus = createEventBus({ redis, tenantId: 't1' });
    await expect(bus.countAfter('r1', '1-0', 2)).resolves.toBe(2);
    expect(calls).toEqual([['bw:t1:run:r1:events', '(1-0', '+', 'COUNT', 2]]);
  });

  it.each(['$', 'abc', '1-2-3', ''])('refuses the cursor %j without touching Redis', async (id) => {
    const redis = {
      xrange: () => {
        throw new Error('must not be called');
      },
    } as unknown as Redis;
    const bus = createEventBus({ redis, tenantId: 't1' });
    await expect(bus.countAfter('r1', id, 5)).rejects.toThrow(ValidationError);
  });

  it.each([0, -1, 1.5])('refuses the limit %s', async (limit) => {
    const bus = createEventBus({ redis: fakeRedis, tenantId: 't1' });
    await expect(bus.countAfter('r1', '1-0', limit)).rejects.toThrow(ValidationError);
  });
});

describe('subscribe onError', () => {
  it('reports each transient read failure and stops when the caller closes the subscription', async () => {
    const errors: unknown[] = [];
    const connection = {
      xread: () => Promise.reject(new Error('connection reset')),
      disconnect: () => undefined,
    };
    const bus = createEventBus({
      redis: fakeRedis,
      tenantId: 't1',
      blockMs: 10,
      createBlockingConnection: () => connection as unknown as Redis,
    });
    const controller = new AbortController();
    const subscription = bus.subscribe('r1', {
      fromId: '0',
      signal: controller.signal,
      onError: (error) => {
        errors.push(error);
        controller.abort();
      },
    });
    const received: unknown[] = [];
    for await (const item of subscription) received.push(item);
    expect(received).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('connection reset');
  });
});
