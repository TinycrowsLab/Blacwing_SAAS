// withOutboxClaim / outboxBacklog against a fake transaction: the claim query shape, the settle
// statements and the rollback-on-throw contract (no database). Locking, ordering and RLS against real
// Postgres are in outbox-relay.int.test.ts.

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';

import { outboxBacklog, withOutboxClaim } from './outbox-relay.js';

import type { Database } from './client.js';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();

function fakeDb(rows: unknown[] = [], roleOk = true) {
  const statements: { text: string; params: unknown[] }[] = [];
  const state = { committed: false, rolledBack: false };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: (query: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(query);
          statements.push({ text: text.replace(/\s+/g, ' ').trim(), params });
          if (text.includes('pg_has_role')) return Promise.resolve({ rows: [{ ok: roleOk }] });
          return Promise.resolve({ rows });
        },
      };
      try {
        const result = await fn(tx);
        state.committed = true;
        return result;
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    },
  } as unknown as Database;
  return { db, statements, state };
}

const record = (over: Record<string, unknown> = {}) => ({
  id: newId(),
  tenant_id: newId(),
  type: 'notify.send',
  aggregate_type: 'run',
  aggregate_id: newId(),
  payload: { a: 1 },
  dedupe_key: 'k',
  attempts: 2,
  created_at: '2026-10-27T10:00:00.000Z',
  ...over,
});

describe('withOutboxClaim', () => {
  it('claims due rows with SKIP LOCKED, oldest first, never past an earlier pending row of the aggregate', async () => {
    const { db, statements } = fakeDb([record()]);
    await withOutboxClaim(db, 50, () => Promise.resolve());
    const claim = statements[1]?.text ?? '';
    expect(claim).toContain("o.status = 'pending'");
    expect(claim).toContain('o.available_at <= now()');
    expect(claim).toContain('NOT EXISTS');
    expect(claim).toContain('(p.created_at, p.id) < (o.created_at, o.id)');
    expect(claim).toContain('ORDER BY o.created_at, o.id');
    expect(claim).toContain('FOR UPDATE OF o SKIP LOCKED');
    expect(statements[1]?.params).toEqual([50]);
  });

  it('pins the nil tenant and requires the bw_relay role before claiming anything', async () => {
    const { db, statements } = fakeDb();
    await withOutboxClaim(db, 5, () => Promise.resolve());
    expect(statements[0]?.text).toContain("pg_has_role(current_user, 'bw_relay', 'USAGE')");
    expect(statements[0]?.text).toContain("set_config('app.tenant_id'");
    expect(statements[0]?.params).toEqual(['00000000-0000-0000-0000-000000000000']);

    const wrongRole = fakeDb([record()], false);
    await expect(withOutboxClaim(wrongRole.db, 5, () => Promise.resolve())).rejects.toThrow(
      /bw_relay/,
    );
    expect(wrongRole.statements).toHaveLength(1);
    expect(wrongRole.state.rolledBack).toBe(true);
  });

  it('maps rows to camelCase and a Date', async () => {
    const row = record();
    const { db } = fakeDb([row]);
    const seen = await withOutboxClaim(db, 10, (claim) => Promise.resolve(claim.rows));
    expect(seen).toEqual([
      {
        id: row.id,
        tenantId: row.tenant_id,
        type: 'notify.send',
        aggregateType: 'run',
        aggregateId: row.aggregate_id,
        payload: { a: 1 },
        dedupeKey: 'k',
        attempts: 2,
        createdAt: new Date('2026-10-27T10:00:00.000Z'),
      },
    ]);
  });

  it('settles rows on the database clock, only while they are still pending', async () => {
    const { db, statements, state } = fakeDb([record()]);
    await withOutboxClaim(db, 10, async (claim) => {
      await claim.markDispatched('a');
      await claim.markRetry('b', 'boom', 1_500);
      await claim.markFailed('c', 'dead');
    });
    const [, , dispatched, retry, failed] = statements;
    expect(dispatched?.text).toContain("status = 'dispatched', dispatched_at = now()");
    expect(retry?.text).toContain('attempts = attempts + 1');
    expect(retry?.text).toContain('available_at = now() + make_interval(secs =>');
    expect(retry?.params).toEqual(['boom', 1.5, 'b']);
    expect(failed?.text).toContain("status = 'failed'");
    for (const statement of [dispatched, retry, failed]) {
      expect(statement?.text).toContain("status = 'pending'");
    }
    expect(state.committed).toBe(true);
  });

  it('rolls back when the callback throws, so every claimed row stays pending', async () => {
    const { db, state } = fakeDb([record()]);
    await expect(withOutboxClaim(db, 10, () => Promise.reject(new Error('crash')))).rejects.toThrow(
      'crash',
    );
    expect(state.rolledBack).toBe(true);
    expect(state.committed).toBe(false);
  });

  it.each([0, -1, 1.5, 1001, Number.NaN])(
    'rejects the batch size %s before any query',
    async (limit) => {
      const { db, statements } = fakeDb();
      await expect(withOutboxClaim(db, limit, () => Promise.resolve())).rejects.toThrow(RangeError);
      expect(statements).toHaveLength(0);
    },
  );
});

describe('outboxBacklog', () => {
  it('counts pending rows per type', async () => {
    const { db } = fakeDb([
      { type: 'notify.send', count: '3' },
      { type: 'audit.event', count: '12' },
    ]);
    expect(await outboxBacklog(db)).toEqual({ 'notify.send': 3, 'audit.event': 12 });
  });

  it('refuses a session that is not the relay role', async () => {
    const { db } = fakeDb([], false);
    await expect(outboxBacklog(db)).rejects.toThrow(/bw_relay/);
  });
});
