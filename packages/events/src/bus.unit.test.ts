// The Redis-backed paths of the event bus against scripted Valkey replies: publish, resumable
// subscribe (cursor resolution, truncation, retries) and consumer groups. The integration suite
// (stream.int.test.ts) proves the same behaviour against a real server; these run in the unit job.
import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { name, version } from './index.js';
import { createEventBus, DEFAULT_STREAM_MAXLEN, type GroupEvent } from './stream.js';

import type { Logger } from '@blackwing/logger';
import type { Redis } from 'ioredis';

const KEY = 'bw:tenant-a:run:run-1:events';
const event = {
  type: 'message.partial',
  ts: '2026-01-01T00:00:00.000Z',
  seq: 1,
  payload: { text: 'hi' },
};

const encoded = (seq: number): string => JSON.stringify({ ...event, seq });
const entry = (id: string, seq: number): [string, string[]] => [id, ['e', encoded(seq)]];

interface Step {
  readonly reply?: unknown;
  readonly error?: Error;
  readonly block?: boolean;
}

/**
 * A blocking connection that answers each XREAD/XREADGROUP from `steps`. An exhausted queue blocks
 * until `disconnect()`, which rejects the pending read the way a closed socket does.
 */
function scriptedConnection(steps: Step[]) {
  const calls: unknown[][] = [];
  let interrupt: ((error: Error) => void) | undefined;
  const answer = (command: string, args: unknown[]): Promise<unknown> => {
    calls.push([command, ...args]);
    const step = steps.shift() ?? { block: true };
    if (step.error !== undefined) return Promise.reject(step.error);
    if (step.block === true) {
      return new Promise((_resolve, reject) => {
        interrupt = reject;
      });
    }
    return Promise.resolve(step.reply);
  };
  const connection = {
    xread: vi.fn((...args: unknown[]) => answer('XREAD', args)),
    xreadgroup: vi.fn((...args: unknown[]) => answer('XREADGROUP', args)),
    disconnect: vi.fn(() => {
      interrupt?.(new Error('Connection closed'));
      interrupt = undefined;
    }),
  };
  return { connection, calls };
}

interface PipelineFake {
  xadd(...args: unknown[]): PipelineFake;
  xlen(...args: unknown[]): PipelineFake;
  expire(...args: unknown[]): PipelineFake;
  exec(): Promise<unknown>;
}

/** A MULTI-less pipeline that records its commands and resolves to `results`. */
function pipelineFake(results: unknown): { pipe: PipelineFake; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pipe: PipelineFake = {
    xadd: (...args) => {
      calls.push(['xadd', ...args]);
      return pipe;
    },
    xlen: (...args) => {
      calls.push(['xlen', ...args]);
      return pipe;
    },
    expire: (...args) => {
      calls.push(['expire', ...args]);
      return pipe;
    },
    exec: () => Promise.resolve(results),
  };
  return { pipe, calls };
}

function fakeLogger() {
  const warn = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as Logger;
  return { log, warn };
}

function fakeMetrics() {
  return { eventPublished: vi.fn(), streamLength: vi.fn(), subscriberLag: vi.fn() };
}

/** Builds a bus over `commands`; every subscriber and consumer reads through `connection`. */
function busWith(
  commands: Record<string, unknown>,
  connection: unknown,
  extra: { metrics?: ReturnType<typeof fakeMetrics>; logger?: Logger } = {},
) {
  return createEventBus({
    redis: commands as unknown as Redis,
    tenantId: 'tenant-a',
    createBlockingConnection: () => connection as Redis,
    blockMs: 50,
    ...extra,
  });
}

describe('publish', () => {
  it('appends a capped, expiring stream entry and returns its id', async () => {
    const { pipe, calls } = pipelineFake([
      [null, '1700-0'],
      [null, 3],
      [null, 1],
    ]);
    const metrics = fakeMetrics();
    const bus = busWith({ pipeline: vi.fn(() => pipe) }, undefined, { metrics });

    await expect(bus.publish('run-1', event)).resolves.toBe('1700-0');
    expect(calls).toContainEqual([
      'xadd',
      KEY,
      'MAXLEN',
      '~',
      DEFAULT_STREAM_MAXLEN,
      '*',
      'e',
      expect.stringContaining('"type":"message.partial"'),
    ]);
    expect(calls).toContainEqual(['expire', KEY, 86_400]);
    expect(metrics.eventPublished).toHaveBeenCalledWith('message.partial');
    expect(metrics.streamLength).toHaveBeenCalledWith('run-1', 3);
  });

  it('fails the publish when XADD is refused and records no metric', async () => {
    const { pipe } = pipelineFake([
      [new Error('READONLY You cannot write'), null],
      [null, 0],
      [null, 0],
    ]);
    const metrics = fakeMetrics();
    const bus = busWith({ pipeline: vi.fn(() => pipe) }, undefined, { metrics });

    await expect(bus.publish('run-1', event)).rejects.toThrow('READONLY');
    expect(metrics.eventPublished).not.toHaveBeenCalled();
  });

  it('fails closed when the pipeline returns no result', async () => {
    const { pipe } = pipelineFake(null);
    const bus = busWith({ pipeline: vi.fn(() => pipe) }, undefined);

    await expect(bus.publish('run-1', event)).rejects.toThrow('XADD returned no result');
  });

  it('still publishes when only the length sample fails', async () => {
    const { pipe } = pipelineFake([
      [null, '1-0'],
      [new Error('timeout'), null],
      [null, 1],
    ]);
    const metrics = fakeMetrics();
    const bus = busWith({ pipeline: vi.fn(() => pipe) }, undefined, { metrics });

    await expect(bus.publish('run-1', event)).resolves.toBe('1-0');
    expect(metrics.eventPublished).toHaveBeenCalledTimes(1);
    expect(metrics.streamLength).not.toHaveBeenCalled();
  });

  it('opens its blocking connection from redis.duplicate() when none is supplied', async () => {
    const { connection } = scriptedConnection([{ block: true }]);
    const duplicate = vi.fn(() => connection);
    const bus = createEventBus({
      redis: { duplicate, xrevrange: vi.fn() } as unknown as Redis,
      tenantId: 'tenant-a',
      blockMs: 50,
    });

    const sub = bus.subscribe('run-1', { fromId: '0' });
    const pending = sub.next();
    await vi.waitFor(() => {
      expect(duplicate).toHaveBeenCalledTimes(1);
    });
    await sub.return?.();
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});

describe('countAfter, ack, trim, expire and remove', () => {
  it('counts the entries after a cursor, bounded by the limit', async () => {
    const xrange = vi.fn(() =>
      Promise.resolve([
        ['2-0', []],
        ['3-0', []],
      ]),
    );
    const bus = busWith({ xrange }, undefined);

    await expect(bus.countAfter('run-1', '1-0', 5)).resolves.toBe(2);
    expect(xrange).toHaveBeenCalledWith(KEY, '(1-0', '+', 'COUNT', 5);
  });

  it('refuses a cursor that is not a stream id, or a non-positive limit', async () => {
    const bus = busWith({ xrange: vi.fn() }, undefined);

    await expect(bus.countAfter('run-1', 'nope', 5)).rejects.toThrow(ValidationError);
    await expect(bus.countAfter('run-1', '1-0', 0)).rejects.toThrow(ValidationError);
  });

  it('acknowledges group deliveries and treats an empty ack as a no-op', async () => {
    const xack = vi.fn(() => Promise.resolve(2));
    const bus = busWith({ xack }, undefined);

    await expect(bus.ack('run-1', 'workers')).resolves.toBe(0);
    expect(xack).not.toHaveBeenCalled();
    await expect(bus.ack('run-1', 'workers', 'a-0', 'b-0')).resolves.toBe(2);
    expect(xack).toHaveBeenCalledWith(KEY, 'workers', 'a-0', 'b-0');
  });

  it('trims to the configured cap by default and rejects a negative cap', async () => {
    const xtrim = vi.fn(() => Promise.resolve(4));
    const bus = busWith({ xtrim }, undefined);

    await expect(bus.trim('run-1')).resolves.toBe(4);
    expect(xtrim).toHaveBeenCalledWith(KEY, 'MAXLEN', DEFAULT_STREAM_MAXLEN);
    await expect(bus.trim('run-1', { maxLen: -1 })).rejects.toThrow(ValidationError);
  });

  it('reports whether the expiry was set', async () => {
    const expireCmd = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const bus = busWith({ expire: expireCmd }, undefined);

    await expect(bus.expire('run-1', 60)).resolves.toBe(true);
    await expect(bus.expire('run-1', 60)).resolves.toBe(false);
    await expect(bus.expire('run-1', 0)).rejects.toThrow(ValidationError);
  });

  it('reports whether the run stream existed when removed', async () => {
    const del = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const bus = busWith({ del }, undefined);

    await expect(bus.remove('run-1')).resolves.toBe(true);
    await expect(bus.remove('run-1')).resolves.toBe(false);
    expect(del).toHaveBeenCalledWith(KEY);
  });
});

describe('subscribe', () => {
  it('refuses a malformed cursor or a non-positive buffer before reading', () => {
    const bus = busWith({}, undefined);

    expect(() => bus.subscribe('run-1', { fromId: 'abc' })).toThrow(ValidationError);
    expect(() => bus.subscribe('run-1', { bufferSize: 0 })).toThrow(ValidationError);
  });

  it('delivers decoded events from a cursor, skips malformed entries and reports lag', async () => {
    const { connection, calls } = scriptedConnection([
      { reply: null },
      {
        reply: [[KEY, [entry('2-0', 1), ['3-0', ['e', '{oops']]]]],
      },
      { block: true },
    ]);
    const metrics = fakeMetrics();
    const { log, warn } = fakeLogger();
    const bus = busWith({}, connection, { metrics, logger: log });

    const sub = bus.subscribe('run-1', { fromId: '0' });
    await expect(sub.next()).resolves.toMatchObject({
      value: { kind: 'event', id: '2-0', event: { seq: 1 } },
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    expect(calls[0]?.at(-1)).toBe('0-0');
    expect(calls[2]?.at(-1)).toBe('3-0');
    expect(metrics.subscriberLag).toHaveBeenCalledWith('run-1', 0);
    expect(metrics.subscriberLag).toHaveBeenCalledWith('run-1', 1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: '3-0' }),
      'skipped malformed run event',
    );
    await sub.return?.();
  });

  it.each([
    ['the newest entry when the stream has events', [['7-0', ['e', 'x']]], '7-0'],
    ['the start when the stream is empty', [], '0-0'],
  ])('resolves $ to %s', async (_label, latest, cursor) => {
    const xrevrange = vi.fn(() => Promise.resolve(latest));
    const { connection, calls } = scriptedConnection([{ block: true }]);
    const bus = busWith({ xrevrange }, connection);

    const sub = bus.subscribe('run-1');
    const pending = sub.next();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(xrevrange).toHaveBeenCalledWith(KEY, '+', '-', 'COUNT', 1);
    expect(calls[0]?.at(-1)).toBe(cursor);
    await sub.return?.();
    await expect(pending).resolves.toMatchObject({ done: true });
  });

  it('delivers a truncation marker first when the cursor fell off the trimmed stream', async () => {
    const xinfo = vi.fn(() =>
      Promise.resolve(['length', 3, 'last-generated-id', '10-0', 'first-entry', ['8-0', []]]),
    );
    const { connection } = scriptedConnection([
      { reply: [[KEY, [entry('10-0', 2)]]] },
      { block: true },
    ]);
    const bus = busWith({ xinfo }, connection);

    const sub = bus.subscribe('run-1', { fromId: '5-0' });
    await expect(sub.next()).resolves.toMatchObject({
      value: { kind: 'truncated', reason: 'trimmed', requestedId: '5-0' },
    });
    await expect(sub.next()).resolves.toMatchObject({ value: { kind: 'event', id: '10-0' } });
    await sub.return?.();
  });

  it('marks a cursor whose stream vanished and resumes from the start', async () => {
    const xinfo = vi.fn(() => Promise.reject(new Error('ERR no such key')));
    const { connection, calls } = scriptedConnection([{ block: true }]);
    const bus = busWith({ xinfo }, connection);

    const sub = bus.subscribe('run-1', { fromId: '5-0' });
    await expect(sub.next()).resolves.toMatchObject({
      value: { kind: 'truncated', reason: 'stream_missing', requestedId: '5-0' },
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.at(-1)).toBe('0-0');
    await sub.return?.();
  });

  it('reports a cursor lookup failure that is not a missing stream through onError', async () => {
    const controller = new AbortController();
    const onError = vi.fn(() => {
      controller.abort();
    });
    const xinfo = vi.fn(() => Promise.reject(new Error('WRONGTYPE')));
    const { connection } = scriptedConnection([]);
    const bus = busWith({ xinfo }, connection);

    const sub = bus.subscribe('run-1', { fromId: '5-0', signal: controller.signal, onError });
    await expect(sub.next()).resolves.toMatchObject({ done: true });
    expect(onError).toHaveBeenCalledWith(new Error('WRONGTYPE'));
  });

  it('retries a transient read failure and reports it through onError', async () => {
    const failure = new Error('socket reset');
    const { connection } = scriptedConnection([
      { error: failure },
      { reply: [[KEY, [entry('1-0', 1)]]] },
      { block: true },
    ]);
    const { log, warn } = fakeLogger();
    const onError = vi.fn();
    const bus = busWith({}, connection, { logger: log });

    const sub = bus.subscribe('run-1', { fromId: '0', onError });
    await expect(sub.next()).resolves.toMatchObject({ value: { id: '1-0' } });
    expect(onError).toHaveBeenCalledWith(failure);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'socket reset' }),
      'event subscription read failed; retrying',
    );
    await sub.return?.();
  });

  it('stops when onError closes the subscription', async () => {
    const controller = new AbortController();
    const onError = vi.fn(() => {
      controller.abort();
    });
    const { connection } = scriptedConnection([{ error: new Error('down') }]);
    const bus = busWith({}, connection);

    const sub = bus.subscribe('run-1', { fromId: '0', signal: controller.signal, onError });
    await expect(sub.next()).resolves.toMatchObject({ done: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('yields nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connection, calls } = scriptedConnection([]);
    const bus = busWith({}, connection);

    const sub = bus.subscribe('run-1', { fromId: '0', signal: controller.signal });
    await expect(sub.next()).resolves.toMatchObject({ done: true });
    expect(calls).toHaveLength(0);
  });

  it('closes an unstarted subscription when thrown into', async () => {
    const { connection, calls } = scriptedConnection([]);
    const bus = busWith({}, connection);

    const sub = bus.subscribe('run-1', { fromId: '0' });
    await expect(sub.throw?.(new Error('stop'))).rejects.toThrow('stop');
    expect(calls).toHaveLength(0);
  });
});

describe('consume', () => {
  it('delivers pending entries, acknowledges them and ignores an existing group', async () => {
    const xgroup = vi.fn(() => Promise.reject(new Error('BUSYGROUP Consumer Group exists')));
    const xack = vi.fn(() => Promise.resolve(1));
    const { connection, calls } = scriptedConnection([
      { reply: [[KEY, [entry('4-0', 4)]]] },
      { block: true },
    ]);
    const bus = busWith({ xgroup, xack }, connection);

    const group = bus.consume('run-1', { group: 'workers', consumer: 'c1' });
    const first = await group.next();
    expect(first.value).toMatchObject({ kind: 'event', id: '4-0', event: { seq: 4 } });
    expect(xgroup).toHaveBeenCalledWith('CREATE', KEY, 'workers', '0', 'MKSTREAM');
    expect(calls[0]?.at(-1)).toBe('0');

    const delivered = first.value as GroupEvent;
    await delivered.ack();
    expect(xack).toHaveBeenCalledWith(KEY, 'workers', '4-0');
    await group.return?.();
  });

  it('acknowledges an unreadable group entry instead of redelivering it forever', async () => {
    const xack = vi.fn(() => Promise.resolve(1));
    const { connection } = scriptedConnection([
      { reply: [[KEY, [['6-0', ['e', '{bad']]]]] },
      { reply: [[KEY, [entry('7-0', 7)]]] },
      { block: true },
    ]);
    const { log, warn } = fakeLogger();
    const bus = busWith({ xgroup: vi.fn(() => Promise.resolve('OK')), xack }, connection, {
      logger: log,
    });

    const group = bus.consume('run-1', { group: 'workers', consumer: 'c1' });
    await expect(group.next()).resolves.toMatchObject({ value: { id: '7-0' } });
    expect(xack).toHaveBeenCalledWith(KEY, 'workers', '6-0');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ id: '6-0' }),
      'dropped unreadable group entry',
    );
    await group.return?.();
  });

  it('switches to new entries once the pending list is empty', async () => {
    const { connection, calls } = scriptedConnection([
      { reply: [[KEY, []]] },
      { reply: [[KEY, [entry('5-0', 5)]]] },
      { block: true },
    ]);
    const bus = busWith({ xgroup: vi.fn(() => Promise.resolve('OK')) }, connection);

    const group = bus.consume('run-1', { group: 'workers', consumer: 'c1' });
    await expect(group.next()).resolves.toMatchObject({ value: { id: '5-0' } });
    expect(calls[1]?.at(-1)).toBe('>');
    await group.return?.();
  });

  it('recreates a vanished group without a warning', async () => {
    const xgroup = vi.fn(() => Promise.resolve('OK'));
    const { connection } = scriptedConnection([
      { error: new Error('NOGROUP No such key') },
      { reply: [[KEY, [entry('8-0', 8)]]] },
      { block: true },
    ]);
    const { log, warn } = fakeLogger();
    const bus = busWith({ xgroup }, connection, { logger: log });

    const group = bus.consume('run-1', { group: 'workers', consumer: 'c1' });
    await expect(group.next()).resolves.toMatchObject({ value: { id: '8-0' } });
    expect(xgroup).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    await group.return?.();
  });

  it('retries other group failures with a warning', async () => {
    const xgroup = vi.fn().mockRejectedValueOnce(new Error('ERR boom')).mockResolvedValue('OK');
    const { connection } = scriptedConnection([
      { reply: [[KEY, [entry('9-0', 9)]]] },
      { block: true },
    ]);
    const { log, warn } = fakeLogger();
    const bus = busWith({ xgroup }, connection, { logger: log });

    const group = bus.consume('run-1', { group: 'workers', consumer: 'c1' });
    await expect(group.next()).resolves.toMatchObject({ value: { id: '9-0' } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ERR boom' }),
      'event group read failed; retrying',
    );
    await group.return?.();
  });

  it('stops after an abort that lands before the next read', async () => {
    const controller = new AbortController();
    // A non-blocking XREADGROUP (pending entries) answers at once; the loop then sees the abort.
    const { connection, calls } = scriptedConnection([{ reply: null }]);
    const bus = busWith({ xgroup: vi.fn(() => Promise.resolve('OK')) }, connection);

    const group = bus.consume('run-1', {
      group: 'workers',
      consumer: 'c1',
      signal: controller.signal,
    });
    const pending = group.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(calls).toHaveLength(1);
  });

  it('refuses an unsafe group name or a non-positive batch size', () => {
    const bus = busWith({}, undefined);

    expect(() => bus.consume('run-1', { group: 'bad group', consumer: 'c1' })).toThrow(
      ValidationError,
    );
    expect(() => bus.consume('run-1', { group: 'workers', consumer: 'c1', batchSize: 0 })).toThrow(
      ValidationError,
    );
  });
});

describe('package entry', () => {
  it('exports the package name and version', () => {
    expect(name).toBe('@blackwing/events');
    expect(version).toBe('0.0.0');
  });
});
