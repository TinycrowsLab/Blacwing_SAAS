// Per-query observability on pooled clients (DB-007): timing, slow and timeout logs, spans, and the
// guarantee that the SQL text and its parameters never reach a log, a span or a metric.

import { describe, expect, it, vi } from 'vitest';

import { instrumentClient, queryOperation, type QueryObserver } from './query-observe.js';

import type pg from 'pg';

const SECRET_PARAM = 'bearer-token-do-not-log-7f3a';
const SECRET_SQL = `SELECT * FROM users WHERE email = '${SECRET_PARAM}'`;

interface Captured {
  readonly warnings: { fields: Record<string, unknown>; message: string }[];
  readonly durations: [string, number][];
}

function observer(slowQueryMs: number, captured: Captured): QueryObserver {
  return {
    pool: 'app',
    slowQueryMs,
    logger: {
      warn: (fields: unknown, message?: string) =>
        captured.warnings.push({
          fields: fields as Record<string, unknown>,
          message: message ?? '',
        }),
    },
    metrics: {
      queryDuration: (op, durationMs) => captured.durations.push([op, durationMs]),
    },
  };
}

function fakeClient(impl: (...args: unknown[]) => unknown): pg.PoolClient {
  return { query: vi.fn(impl) } as unknown as pg.PoolClient;
}

/** Makes `performance.now()` advance by `ms` for the duration of one statement. */
function clockAdvancing(ms: number): () => void {
  let calls = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
    calls += 1;
    return calls === 1 ? 1000 : 1000 + ms;
  });
  return () => {
    spy.mockRestore();
  };
}

describe('queryOperation', () => {
  it('returns the leading keyword, upper-cased and from a fixed set', () => {
    expect(queryOperation('  select 1')).toBe('SELECT');
    expect(queryOperation('INSERT INTO t VALUES ($1)')).toBe('INSERT');
    expect(queryOperation('DROP TABLE users')).toBe('OTHER');
    expect(queryOperation(undefined)).toBe('OTHER');
    expect(queryOperation('')).toBe('OTHER');
  });
});

describe('instrumentClient', () => {
  it('logs db.query.slow at or above the threshold and nothing for a fast query', async () => {
    const captured: Captured = { warnings: [], durations: [] };
    const restore = clockAdvancing(500);
    try {
      const client = fakeClient(() => Promise.resolve({ rows: [], rowCount: 3 }));
      instrumentClient(client, observer(500, captured));
      await client.query(SECRET_SQL, [SECRET_PARAM]);
    } finally {
      restore();
    }
    expect(captured.warnings).toHaveLength(1);
    expect(captured.warnings[0]?.message).toBe('db.query.slow');
    expect(captured.warnings[0]?.fields).toEqual({
      pool: 'app',
      op: 'SELECT',
      durationMs: 500,
      rowCount: 3,
    });
  });

  it('does not log a fast query', async () => {
    const captured: Captured = { warnings: [], durations: [] };
    const restore = clockAdvancing(499);
    try {
      const client = fakeClient(() => Promise.resolve({ rows: [], rowCount: 1 }));
      instrumentClient(client, observer(500, captured));
      await client.query('SELECT 1');
    } finally {
      restore();
    }
    expect(captured.warnings).toEqual([]);
    expect(captured.durations).toEqual([['SELECT', 499]]);
  });

  it('logs db.query.timeout for SQLSTATE 57014 and rethrows the original error', async () => {
    const captured: Captured = { warnings: [], durations: [] };
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const client = fakeClient(() => Promise.reject(cancelled));
    instrumentClient(client, observer(500, captured));
    await expect(client.query('SELECT pg_sleep(60)')).rejects.toBe(cancelled);
    expect(captured.warnings.map((w) => w.message)).toEqual(['db.query.timeout']);
    expect(captured.warnings[0]?.fields).toMatchObject({ op: 'SELECT', sqlstate: '57014' });
  });

  it('never puts the SQL text or its parameters into a log field or a metric', async () => {
    const captured: Captured = { warnings: [], durations: [] };
    const failing = Object.assign(new Error(`bad ${SECRET_PARAM}`), { code: '23505' });
    const client = fakeClient(() => Promise.reject(failing));
    instrumentClient(client, observer(0, captured));
    await expect(client.query(SECRET_SQL, [SECRET_PARAM])).rejects.toBe(failing);
    const everything = JSON.stringify([captured.warnings, captured.durations]);
    expect(everything).not.toContain(SECRET_PARAM);
    expect(everything).not.toContain('users');
  });

  it('wraps each client once, however often it is checked out', async () => {
    const captured: Captured = { warnings: [], durations: [] };
    const client = fakeClient(() => Promise.resolve({ rows: [], rowCount: 0 }));
    instrumentClient(client, observer(500, captured));
    instrumentClient(client, observer(500, captured));
    await client.query('SELECT 1');
    expect(captured.durations).toHaveLength(1);
  });

  it('leaves callback-style calls to node-postgres untouched', () => {
    const captured: Captured = { warnings: [], durations: [] };
    const original = vi.fn((...args: unknown[]) => args.at(-1));
    const client = { query: original } as unknown as pg.PoolClient;
    instrumentClient(client, observer(500, captured));
    const callback = (): void => undefined;
    client.query('SELECT 1', callback);
    expect(original).toHaveBeenCalledWith('SELECT 1', callback);
    expect(captured.durations).toEqual([]);
  });
});
