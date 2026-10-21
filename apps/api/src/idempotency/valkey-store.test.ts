import { describe, expect, it } from 'vitest';

import {
  IdempotencyRecordCorruptError,
  ValkeyIdempotencyStore,
  type ValkeyCommandClient,
} from './valkey-store.js';

import type { CompletedRecord, InProgressRecord } from './record.js';

const HASH = 'a'.repeat(64);
const inProgress: InProgressRecord = {
  state: 'in_progress',
  keyHash: HASH,
  fingerprint: HASH,
  token: 'tok',
  startedAt: '2026-01-01T00:00:00.000Z',
};
const completed: CompletedRecord = {
  state: 'completed',
  keyHash: HASH,
  fingerprint: HASH,
  result: { kind: 'stored', status: 201, headers: {}, body: '{}' },
  completedAt: '2026-01-01T00:00:01.000Z',
};

interface Calls {
  set: unknown[][];
  get: string[];
  evals: unknown[][];
}

function fakeClient(options: {
  setReply?: 'OK' | null;
  getReply?: string | null;
  evalReply?: unknown;
}): { client: ValkeyCommandClient; calls: Calls } {
  const calls: Calls = { set: [], get: [], evals: [] };
  const client: ValkeyCommandClient = {
    set: (...args) => {
      calls.set.push(args);
      return Promise.resolve(options.setReply === undefined ? 'OK' : options.setReply);
    },
    get: (key) => {
      calls.get.push(key);
      return Promise.resolve(options.getReply ?? null);
    },
    eval: (...args) => {
      calls.evals.push(args);
      return Promise.resolve(options.evalReply ?? 1);
    },
  };
  return { client, calls };
}

describe('ValkeyIdempotencyStore', () => {
  it('acquires with SET key value PX ttl NX', async () => {
    const { client, calls } = fakeClient({});
    const result = await new ValkeyIdempotencyStore(client).acquire('idem:k', inProgress, 120_000);
    expect(result).toEqual({ acquired: true });
    expect(calls.set).toEqual([['idem:k', JSON.stringify(inProgress), 'PX', 120_000, 'NX']]);
    expect(calls.get).toHaveLength(0);
  });

  it('returns the existing record when the key is taken', async () => {
    const { client } = fakeClient({ setReply: null, getReply: JSON.stringify(completed) });
    expect(await new ValkeyIdempotencyStore(client).acquire('idem:k', inProgress, 1000)).toEqual({
      acquired: false,
      existing: completed,
    });
  });

  it('reports null when the key vanished between the set and the get', async () => {
    const { client } = fakeClient({ setReply: null, getReply: null });
    expect(await new ValkeyIdempotencyStore(client).acquire('idem:k', inProgress, 1000)).toEqual({
      acquired: false,
      existing: null,
    });
  });

  it.each(['not json', '{"state":"weird"}', JSON.stringify({ ...completed, fingerprint: 'zz' })])(
    'refuses an unreadable stored value (%s) instead of trusting it',
    async (raw) => {
      const { client } = fakeClient({ setReply: null, getReply: raw });
      await expect(
        new ValkeyIdempotencyStore(client).acquire('idem:k', inProgress, 1000),
      ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    },
  );

  it('completes and releases through token-checked scripts on one key', async () => {
    const { client, calls } = fakeClient({});
    const store = new ValkeyIdempotencyStore(client);
    expect(await store.complete('idem:k', 'tok', completed, 86_400_000)).toBe(true);
    expect(await store.release('idem:k', 'tok')).toBe(true);
    const [complete, release] = calls.evals;
    expect(complete?.slice(1)).toEqual([1, 'idem:k', 'tok', JSON.stringify(completed), '86400000']);
    expect(String(complete?.[0])).toContain('record.token == ARGV[1]');
    expect(release?.slice(1)).toEqual([1, 'idem:k', 'tok']);
    expect(String(release?.[0])).toContain('record.token == ARGV[1]');
  });

  it('reports a lost lock as false', async () => {
    const { client } = fakeClient({ evalReply: 0 });
    const store = new ValkeyIdempotencyStore(client);
    expect(await store.complete('idem:k', 'tok', completed, 1000)).toBe(false);
    expect(await store.release('idem:k', 'tok')).toBe(false);
  });
});
