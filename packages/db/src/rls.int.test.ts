// rls helper: isolation, fail-closed context, WITH CHECK and FORCE against real Postgres 16
// (DB-003, CONTEXT_PACK §7, §8.6).

import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { assertRlsEnabled, readRlsState, RlsConfigError, rlsPolicySql } from './rls.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Runs `fn` as the table owner (no bw_app) with `app.tenant_id` set, in a rolled-back transaction. */
async function asOwnerWithTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

beforeAll(async () => {
  db = await withPostgres({
    migrations: async (owner) => {
      await owner.query(
        'CREATE TABLE rls_sample (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, label text NOT NULL)',
      );
      await owner.query(rlsPolicySql('rls_sample'));
      await owner.query('CREATE TABLE rls_unprotected (id uuid PRIMARY KEY, tenant_id uuid)');
    },
  });
  for (const tenant of [tenantA, tenantB]) {
    await db.withTenant(tenant, async (tx) => {
      await tx.query('INSERT INTO rls_sample VALUES ($1, $2, $3), ($4, $2, $5)', [
        newId(),
        tenant,
        'one',
        newId(),
        'two',
      ]);
    });
  }
});

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('rlsPolicySql applied to a sample table', () => {
  it('enables + forces RLS and creates exactly one policy', async () => {
    const state = await readRlsState(db.ownerPool, 'rls_sample');
    expect(state.enabled).toBe(true);
    expect(state.forced).toBe(true);
    expect(state.policies).toHaveLength(1);
    expect(state.policies[0]?.name).toBe('rls_sample_tenant_isolation');
    await expect(assertRlsEnabled(db.ownerPool, 'rls_sample')).resolves.toBeUndefined();
  });

  it('assertRlsEnabled rejects a table without RLS and a missing table', async () => {
    await expect(assertRlsEnabled(db.ownerPool, 'rls_unprotected')).rejects.toThrow(/not enabled/);
    await expect(assertRlsEnabled(db.ownerPool, 'nope_table')).rejects.toThrow(RlsConfigError);
  });

  it('assertRlsEnabled rejects an enabled but not forced table and a wrong policy count', async () => {
    await db.ownerPool.query('CREATE TABLE rls_half (id uuid, tenant_id uuid)');
    await db.ownerPool.query('ALTER TABLE rls_half ENABLE ROW LEVEL SECURITY');
    await expect(assertRlsEnabled(db.ownerPool, 'rls_half')).rejects.toThrow(/not forced/);
    await db.ownerPool.query('ALTER TABLE rls_half FORCE ROW LEVEL SECURITY');
    await expect(assertRlsEnabled(db.ownerPool, 'rls_half')).rejects.toThrow(/exactly one policy/);
    await db.ownerPool.query(
      'CREATE POLICY rls_half_tenant_isolation ON rls_half USING (true) WITH CHECK (true)',
    );
    await expect(assertRlsEnabled(db.ownerPool, 'rls_half')).rejects.toThrow(/canonical|predicate/);
  });

  it('bw_app holds SELECT/INSERT/UPDATE/DELETE and no TRUNCATE; PUBLIC holds nothing', async () => {
    const { rows } = await db.ownerPool.query<{ privilege_type: string; grantee: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'rls_sample' AND grantee IN ('bw_app', 'PUBLIC')`,
    );
    const app = rows.filter((r) => r.grantee === 'bw_app').map((r) => r.privilege_type);
    expect(app.sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(rows.some((r) => r.grantee === 'PUBLIC')).toBe(false);
  });
});

describe('isolation as bw_app', () => {
  it('a SELECT returns only the current tenant rows', async () => {
    const a = await db.withTenant(tenantA, (tx) => tx.query('SELECT tenant_id FROM rls_sample'));
    expect(a.rows).toHaveLength(2);
    expect(a.rows.every((r: { tenant_id: string }) => r.tenant_id === tenantA)).toBe(true);
    const b = await db.withTenant(tenantB, (tx) => tx.query('SELECT tenant_id FROM rls_sample'));
    expect(b.rows.every((r: { tenant_id: string }) => r.tenant_id === tenantB)).toBe(true);
  });

  it('insert of a row for another tenant is rejected by WITH CHECK', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('INSERT INTO rls_sample VALUES ($1, $2, $3)', [newId(), tenantB, 'x']),
      ),
    );
    expect(code).toBe('42501');
  });

  it('update moving a row to another tenant is rejected by WITH CHECK', async () => {
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query('UPDATE rls_sample SET tenant_id = $1', [tenantB])),
    );
    expect(code).toBe('42501');
  });

  it('cross-tenant update and delete affect 0 rows (USING hides them, no error)', async () => {
    const count = () =>
      db.withTenant(tenantB, (tx) => tx.query('SELECT count(*)::int AS n FROM rls_sample'));
    const before = await count();
    const upd = await db.withTenant(tenantA, (tx) =>
      tx.query('UPDATE rls_sample SET label = $1 WHERE tenant_id = $2', ['hacked', tenantB]),
    );
    const del = await db.withTenant(tenantA, (tx) =>
      tx.query('DELETE FROM rls_sample WHERE tenant_id = $1', [tenantB]),
    );
    expect(upd.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
    const after = await count();
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('a query with no app.tenant_id raises instead of returning rows', async () => {
    const client = await db.appPool.connect();
    try {
      const code = await pgCode(client.query('SELECT * FROM rls_sample'));
      // 42704 on a fresh session; 22P02 when a pooled session once set the GUC (it resets to '').
      expect(['42704', '22P02']).toContain(code);
    } finally {
      client.release();
    }
  });

  it('a fresh pooled connection after a tenant transaction does not inherit the tenant', async () => {
    await db.withTenant(tenantA, (tx) => tx.query('SELECT 1'));
    const code = await pgCode(db.appPool.query('SELECT * FROM rls_sample'));
    expect(['42704', '22P02']).toContain(code);
  });

  it('an invalid UUID in app.tenant_id is a cast error, not a match', async () => {
    const client = await db.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', 'not-a-uuid', true)");
      const code = await pgCode(client.query('SELECT * FROM rls_sample'));
      expect(code).toBe('22P02');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('bw_app cannot TRUNCATE', async () => {
    const code = await pgCode(db.appPool.query('TRUNCATE rls_sample'));
    expect(code).toBe('42501');
  });
});

describe('FORCE constrains the table owner', () => {
  it('the owner sees only its tenant rows and is blocked by WITH CHECK', async () => {
    await asOwnerWithTenant(tenantA, async (client) => {
      const { rows } = await client.query('SELECT tenant_id FROM rls_sample');
      expect(rows).toHaveLength(2);
      expect(rows.every((r: { tenant_id: string }) => r.tenant_id === tenantA)).toBe(true);
    });
    await asOwnerWithTenant(tenantA, async (client) => {
      const code = await pgCode(
        client.query('INSERT INTO rls_sample VALUES ($1, $2, $3)', [newId(), tenantB, 'x']),
      );
      expect(code).toBe('42501');
    });
  });

  it('without FORCE the owner would bypass: proves FORCE is what constrains it', async () => {
    await db.ownerPool.query('CREATE TABLE rls_noforce (id uuid, tenant_id uuid NOT NULL)');
    await db.ownerPool.query('ALTER TABLE rls_noforce ENABLE ROW LEVEL SECURITY');
    await db.ownerPool.query(
      "CREATE POLICY p ON rls_noforce USING (tenant_id = current_setting('app.tenant_id')::uuid)",
    );
    await db.ownerPool.query('INSERT INTO rls_noforce VALUES ($1, $2), ($3, $4)', [
      newId(),
      tenantA,
      newId(),
      tenantB,
    ]);
    const { rows } = await db.ownerPool.query('SELECT 1 FROM rls_noforce');
    expect(rows).toHaveLength(2);
  });
});

describe('property: random tenant pairs never see each other', () => {
  it('each tenant reads exactly its own rows', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid({ version: 7 }), fc.uuid({ version: 7 }), async (x, y) => {
        fc.pre(x !== y);
        await db.withTenant(x, (tx) =>
          tx.query('INSERT INTO rls_sample VALUES ($1, $2, $3)', [newId(), x, 'px']),
        );
        await db.withTenant(y, (tx) =>
          tx.query('INSERT INTO rls_sample VALUES ($1, $2, $3)', [newId(), y, 'py']),
        );
        const seenByX = await db.withTenant(x, (tx) =>
          tx.query('SELECT tenant_id FROM rls_sample'),
        );
        const seenByY = await db.withTenant(y, (tx) =>
          tx.query('SELECT tenant_id FROM rls_sample'),
        );
        expect(seenByX.rows.every((r: { tenant_id: string }) => r.tenant_id === x)).toBe(true);
        expect(seenByY.rows.every((r: { tenant_id: string }) => r.tenant_id === y)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });
});
