// Coverage manifests (F19, REPORT-001): tenant isolation, forced RLS, fail-closed context and the composite key to
// runs, against the real migrations on Postgres (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();

/** Postgres error code of a rejected promise (23503 foreign key, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

/** Inserts a run for a tenant and returns its id. */
async function insertRun(tenant: string): Promise<string> {
  const id = newId();
  await db.withTenant(tenant, (tx) =>
    tx.query('INSERT INTO runs (id, tenant_id) VALUES ($1, $2)', [id, tenant]),
  );
  return id;
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await (db as PostgresHandle | undefined)?.stop();
});

describe('coverage_manifests', () => {
  it('has forced row level security, so the owner role is confined to the tenant policy too', async () => {
    const { rows } = await db.ownerPool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'coverage_manifests'",
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });

  it('shows a tenant its own manifest and hides another tenant’s', async () => {
    const runA = await insertRun(tenantA);
    await db.withTenant(tenantA, (tx) =>
      tx.query('INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)', [
        newId(),
        tenantA,
        runA,
      ]),
    );
    const own = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT run_id FROM coverage_manifests WHERE run_id = $1', [runA]),
    );
    const foreign = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT run_id FROM coverage_manifests WHERE run_id = $1', [runA]),
    );
    expect(own.rows).toHaveLength(1);
    expect(foreign.rows).toHaveLength(0);
  });

  it('refuses a manifest that names another tenant’s run (composite key to runs)', async () => {
    const runA = await insertRun(tenantA);
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)', [
          newId(),
          tenantB,
          runA,
        ]),
      ),
    );
    expect(code).toBe('23503');
  });

  it('refuses a second manifest for the same run of the same tenant', async () => {
    const run = await insertRun(tenantB);
    await db.withTenant(tenantB, (tx) =>
      tx.query('INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)', [
        newId(),
        tenantB,
        run,
      ]),
    );
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query('INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)', [
          newId(),
          tenantB,
          run,
        ]),
      ),
    );
    expect(code).toBe('23505');
  });

  it('fails closed with no tenant context: the table reads as an error, never as every tenant’s rows', async () => {
    await expect(db.appPool.query('SELECT run_id FROM coverage_manifests')).rejects.toThrow();
  });

  it('gives the runtime role no DELETE on a manifest', async () => {
    const run = await insertRun(tenantA);
    await db.withTenant(tenantA, (tx) =>
      tx.query('INSERT INTO coverage_manifests (id, tenant_id, run_id) VALUES ($1, $2, $3)', [
        newId(),
        tenantA,
        run,
      ]),
    );
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM coverage_manifests WHERE run_id = $1', [run]),
      ),
    );
    expect(code).toBe('42501');
  });
});
