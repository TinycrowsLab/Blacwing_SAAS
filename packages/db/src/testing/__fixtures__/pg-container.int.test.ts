// Meta-test for the Testcontainers Postgres harness (issue #76): one container boots with the real
// migrations and FORCE RLS, two workers stay isolated, reset() returns to the seeded baseline, and the
// audit ledger's truncate guard survives a reset. Runs as bw_app (RLS applies) against Postgres 16.
// Run with `pnpm --filter @blackwing/db test:int`; it needs a container runtime.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';

import { type TestDatabase, type TestSeed, startTestDatabase } from './pg-container.js';

import type pg from 'pg';

const tenantA = newId();
const tenantB = newId();
const seededUser = newId();

/**
 * Seeds tenant A, its user and one membership, as the owner. The tenant and user rows are not tenant
 * tables, so reset() keeps them: the inserts are idempotent. The membership needs the tenant context
 * (FORCE RLS applies to the owner too).
 */
const seedTenantA: TestSeed = async (owner) => {
  // tenants is isolated on its id: the tenant context is set first (current_setting has no default).
  await owner.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
  await owner.query(
    "INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, 'Tenant A', 'eu-west-1') ON CONFLICT DO NOTHING",
    [tenantA, `t-${tenantA}`],
  );
  await owner.query(
    'INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [seededUser, `sub-${seededUser}`, `${seededUser}@test.invalid`],
  );
  await owner.query(
    'INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [tenantA, seededUser],
  );
};

async function countMemberships(db: TestDatabase, tenantId: string): Promise<number> {
  return db.withTestTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM memberships');
    return Number(rows[0]?.n);
  });
}

async function triggerState(owner: pg.Pool, name: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ state: string }>(
    'SELECT tgenabled AS state FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal',
    [name],
  );
  return rows[0]?.state;
}

let db: TestDatabase;

beforeAll(async () => {
  db = await startTestDatabase({ seed: seedTenantA });
}, 240_000);

afterAll(async () => {
  await db.stop();
});

describe('startTestDatabase', () => {
  it('connects the app pool as bw_app, never as a superuser or BYPASSRLS role', async () => {
    const { rows } = await db.appPool.query<{ user: string; super: boolean; bypass: boolean }>(
      `SELECT current_user AS "user", r.rolsuper AS super, r.rolbypassrls AS bypass
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ user: 'bw_app', super: false, bypass: false });
  });

  it('applied the migrations and FORCE RLS on every tenant table (the owner pool sees them)', async () => {
    const { rows } = await db.ownerPool.query<{ forced: boolean; policies: string }>(
      `SELECT c.relforcerowsecurity AS forced, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.relname = 'memberships'`,
    );
    expect(rows[0]?.forced).toBe(true);
    expect(Number(rows[0]?.policies)).toBeGreaterThan(0);
  });

  it('runs the seed after the migrations', async () => {
    expect(await countMemberships(db, tenantA)).toBe(1);
  });

  it('fails closed for another tenant: RLS hides tenant A rows from tenant B', async () => {
    expect(await countMemberships(db, tenantB)).toBe(0);
  });
});

describe('TestDatabase.reset', () => {
  it('returns the tenant tables to the seeded baseline, and the seed runs again', async () => {
    const secondUser = newId();
    await db.ownerPool.query('INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)', [
      secondUser,
      `sub-${secondUser}`,
      `${secondUser}@test.invalid`,
    ]);
    await db.withTestTenant(tenantA, (tx) =>
      tx.query('INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)', [
        tenantA,
        secondUser,
      ]),
    );
    expect(await countMemberships(db, tenantA)).toBe(2);

    await db.reset();

    expect(await countMemberships(db, tenantA)).toBe(1);
  });

  it('keeps the audit ledger guard enabled and still refusing TRUNCATE after a reset', async () => {
    await db.reset();

    expect(await triggerState(db.ownerPool, 'audit_events_no_mutate')).toBe('O');
    await expect(db.ownerPool.query('TRUNCATE audit_events')).rejects.toThrow();
  });

  it('keeps the schema, roles and RLS intact (reset never drops)', async () => {
    await db.reset();

    const { rows } = await db.ownerPool.query<{ forced: boolean }>(
      "SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'memberships'",
    );
    expect(rows[0]?.forced).toBe(true);
    expect(await countMemberships(db, tenantA)).toBe(1);
  });
});

describe('parallel test databases', () => {
  it('two concurrently started databases never see each other rows', async () => {
    const [first, second] = await Promise.all([
      startTestDatabase({ seed: seedTenantA }),
      startTestDatabase(),
    ]);
    try {
      expect(first.database).not.toBe(second.database);
      expect(await countMemberships(first, tenantA)).toBe(1);
      expect(await countMemberships(second, tenantA)).toBe(0);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  }, 240_000);
});

describe('startup failure', () => {
  it('rejects when the seed fails, so no half-prepared database is handed out', async () => {
    const broken: TestSeed = () => Promise.reject(new Error('seed exploded'));

    await expect(startTestDatabase({ seed: broken })).rejects.toThrow('seed exploded');
  }, 240_000);
});
