// withTenant / withSystem against real Postgres 16 as bw_app (DB-004, CONTEXT_PACK §7, §8.6).
// Runs through Testcontainers (`pnpm test:int`); the statement-level behaviour is covered without a
// database in with-tenant.test.ts.

import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createDatabase, type Database } from './client.js';
import { rlsPolicySql } from './rls.js';
import {
  type SystemAccessEvent,
  TenantContextMismatchError,
  TxRetryExhaustedError,
  withSystem,
  withTenant,
} from './with-tenant.js';

let handle: PostgresHandle;
let db: Database;
const tenantA = newId();
const tenantB = newId();
const fast = { backoffMs: () => 0, maxRetries: 3 } as const;

const rowsOf = async (
  tx: Pick<Database, 'execute'>,
  query: ReturnType<typeof sql>,
): Promise<Record<string, unknown>[]> => (await tx.execute(query)).rows;

/** True when the session-visible `app.tenant_id` is unset (null) or reset to empty. */
async function unsetContext(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ t: string | null }>(
    "SELECT current_setting('app.tenant_id', true) AS t",
  );
  return rows[0]?.t === null || rows[0]?.t === '';
}

async function labels(tenant: string): Promise<string[]> {
  return withTenant(db, tenant, async (tx) => {
    const rows = await rowsOf(tx, sql`SELECT label FROM wt_sample ORDER BY label`);
    return rows.map((r) => String(r.label));
  });
}

beforeAll(async () => {
  handle = await withPostgres({
    migrations: async (owner) => {
      await owner.query(
        'CREATE TABLE wt_sample (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, label text NOT NULL)',
      );
      await owner.query(rlsPolicySql('wt_sample'));
      // A table without tenant data, for withSystem.
      await owner.query('CREATE TABLE wt_platform (id int PRIMARY KEY, note text NOT NULL)');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON wt_platform TO bw_app');
      // Two rows used to force a real write skew between serializable transactions.
      await owner.query('CREATE TABLE wt_skew (id int PRIMARY KEY, v int NOT NULL)');
      await owner.query('INSERT INTO wt_skew VALUES (1, 0), (2, 0)');
      await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON wt_skew TO bw_app');
    },
  });
  db = createDatabase(handle.appPool);
  for (const [tenant, names] of [
    [tenantA, ['a1', 'a2']],
    [tenantB, ['b1']],
  ] as const) {
    await withTenant(db, tenant, async (tx) => {
      for (const label of names) {
        await tx.execute(sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenant}, ${label})`);
      }
    });
  }
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (handle as PostgresHandle | undefined)?.stop();
});

describe('isolation and context lifetime', () => {
  it('inside withTenant(A) only tenant A rows are visible', async () => {
    expect(await labels(tenantA)).toEqual(['a1', 'a2']);
    expect(await labels(tenantB)).toEqual(['b1']);
  });

  it('exposes the tenant through app.tenant_id only inside the transaction', async () => {
    const inside = await withTenant(db, tenantA, async (tx) => {
      const rows = await rowsOf(tx, sql`SELECT current_setting('app.tenant_id') AS t`);
      return rows[0]?.t;
    });
    expect(inside).toBe(tenantA);
  });

  it('clears the context after commit: the next query without a tenant fails closed', async () => {
    await withTenant(db, tenantA, () => Promise.resolve());
    await expect(db.execute(sql`SELECT * FROM wt_sample`)).rejects.toMatchObject({
      cause: { code: expect.stringMatching(/^(42704|22P02)$/) as unknown },
    });
  });

  it('clears the context after rollback', async () => {
    await withTenant(db, tenantA, () => Promise.reject(new Error('boom'))).catch(() => undefined);
    expect(await unsetContext(handle.appPool)).toBe(true);
  });

  it('does not leak the context to a reused pooled connection', async () => {
    const single = new pg.Pool({ ...handle.connectionConfig('app'), max: 1 });
    try {
      const one = createDatabase(single);
      await withTenant(one, tenantA, () => Promise.resolve());
      await withTenant(one, tenantB, async (tx) => {
        const rows = await rowsOf(tx, sql`SELECT label FROM wt_sample`);
        expect(rows.map((r) => r.label)).toEqual(['b1']);
      });
      expect(await unsetContext(single)).toBe(true);
      await expect(one.execute(sql`SELECT * FROM wt_sample`)).rejects.toBeDefined();
    } finally {
      await single.end();
    }
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      withTenant(db, tenantA, async (tx) => {
        await tx.execute(sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenantA}, 'ghost')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await labels(tenantA)).toEqual(['a1', 'a2']);
  });

  it('WITH CHECK still refuses a write for another tenant inside withTenant', async () => {
    await expect(
      withTenant(db, tenantA, (tx) =>
        tx.execute(sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenantB}, 'x')`),
      ),
    ).rejects.toBeDefined();
    expect(await labels(tenantB)).toEqual(['b1']);
  });
});

describe('fail closed before any query', () => {
  it.each([undefined, null, ''])('rejects %j as missing', async (value) => {
    await expect(
      withTenant(db, value as unknown as string, () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING', meta: { reason: 'missing' } });
  });

  it.each(['not-a-uuid', "'; DROP TABLE wt_sample; --", `${tenantA} `])(
    'rejects %j as invalid_uuid',
    async (value) => {
      await expect(withTenant(db, value, () => Promise.resolve())).rejects.toMatchObject({
        code: 'TENANT_CONTEXT_MISSING',
        meta: { reason: 'invalid_uuid' },
      });
      expect(await labels(tenantA)).toEqual(['a1', 'a2']);
    },
  );
});

describe('retry', () => {
  it('retries an injected 40001 once and then succeeds', async () => {
    let calls = 0;
    const result = await withTenant(
      db,
      tenantA,
      async (tx) => {
        calls += 1;
        if (calls === 1) {
          // A real SQLSTATE 40001 raised by the server.
          await tx.execute(
            sql`DO $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$`,
          );
        }
        return (await rowsOf(tx, sql`SELECT count(*)::int AS n FROM wt_sample`))[0]?.n;
      },
      fast,
    );
    expect(calls).toBe(2);
    expect(result).toBe(2);
  });

  it('exhausts always-failing serialization with TX_RETRY_EXHAUSTED', async () => {
    let calls = 0;
    const error = await withTenant(
      db,
      tenantA,
      async (tx) => {
        calls += 1;
        await tx.execute(
          sql`DO $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$`,
        );
      },
      { ...fast, maxRetries: 2 },
    ).catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(TxRetryExhaustedError);
    expect(error).toMatchObject({ code: 'TX_RETRY_EXHAUSTED', attempts: 3 });
  });

  it('resolves a real write skew between serializable transactions by retrying', async () => {
    // Each transaction reads both rows then writes one: under SERIALIZABLE one of them must fail with
    // 40001 and succeed on retry.
    let arrived = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = (writeId: number): Promise<number> =>
      withTenant(
        db,
        tenantA,
        async (tx) => {
          const read = await rowsOf(tx, sql`SELECT sum(v)::int AS s FROM wt_skew`);
          if (arrived < 2) {
            arrived += 1;
            if (arrived === 2) release();
            await gate;
          }
          await tx.execute(sql`UPDATE wt_skew SET v = v + 1 WHERE id = ${writeId}`);
          return Number(read[0]?.s);
        },
        { ...fast, isolation: 'serializable' },
      );
    await Promise.all([run(1), run(2)]);
    const total = await handle.ownerPool.query<{ s: number }>(
      'SELECT sum(v)::int AS s FROM wt_skew',
    );
    expect(total.rows[0]?.s).toBe(2);
  });
});

describe('nesting', () => {
  it('a nested call for the same tenant shares the transaction (sees uncommitted rows)', async () => {
    let seen = 0;
    await withTenant(db, tenantA, async (outer) => {
      await outer.execute(sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenantA}, 'nested')`);
      seen = await withTenant(db, tenantA, async (inner) => {
        const rows = await rowsOf(inner, sql`SELECT label FROM wt_sample WHERE label = 'nested'`);
        return rows.length;
      });
      throw new Error('discard');
    }).catch(() => undefined);
    expect(seen).toBe(1);
    expect(await labels(tenantA)).toEqual(['a1', 'a2']);
  });

  it('a nested call for a different tenant throws TENANT_CONTEXT_CONFLICT and rolls back', async () => {
    const error = await withTenant(db, tenantA, async (tx) => {
      await tx.execute(sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenantA}, 'half')`);
      await withTenant(db, tenantB, () => Promise.resolve());
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantContextMismatchError);
    expect(error).toMatchObject({ code: 'TENANT_CONTEXT_CONFLICT' });
    expect(await labels(tenantA)).toEqual(['a1', 'a2']);
  });
});

describe('withSystem', () => {
  it('reaches non-tenant tables, sets no tenant, and audits', async () => {
    const events: SystemAccessEvent[] = [];
    await withSystem(
      db,
      async (tx) => {
        await tx.execute(sql`INSERT INTO wt_platform VALUES (1, 'x') ON CONFLICT DO NOTHING`);
        const rows = await rowsOf(tx, sql`SELECT current_setting('app.tenant_id', true) AS t`);
        expect(rows[0]?.t === null || rows[0]?.t === '').toBe(true);
      },
      {
        ...fast,
        actor: 'ops',
        reason: 'integration test',
        audit: (event) => void events.push(event),
      },
    );
    expect(events.map((e) => e.phase)).toEqual(['started', 'succeeded']);
  });

  it('cannot read tenant tables: RLS stays closed without a tenant', async () => {
    await expect(
      withSystem(db, (tx) => tx.execute(sql`SELECT * FROM wt_sample`), {
        ...fast,
        actor: 'ops',
        reason: 'must fail closed',
        audit: () => undefined,
      }),
    ).rejects.toBeDefined();
  });
});

describe('properties', () => {
  it('concurrent writers with random tenants never observe each other', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.uuid({ version: 7 }), { minLength: 2, maxLength: 5 }),
        async (tenants) => {
          const seen = await Promise.all(
            tenants.map((tenant) =>
              withTenant(
                db,
                tenant,
                async (tx) => {
                  await tx.execute(
                    sql`INSERT INTO wt_sample VALUES (${newId()}, ${tenant}, ${`p-${tenant}`})`,
                  );
                  const rows = await rowsOf(tx, sql`SELECT DISTINCT tenant_id FROM wt_sample`);
                  return rows.map((r) => String(r.tenant_id));
                },
                fast,
              ),
            ),
          );
          seen.forEach((tenantIds, index) => {
            expect(tenantIds).toEqual([tenants[index]]);
          });
        },
      ),
      { numRuns: 10 },
    );
  });
});
