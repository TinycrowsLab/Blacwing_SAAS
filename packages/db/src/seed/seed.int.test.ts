// db:seed against Postgres 16 (Testcontainers) with the real migrations: fail-fast preflight, population, idempotency,
// reset, SoD, secret refs, tenant scoping under RLS and cross-tenant isolation (§8.4, §8.6, §8.7, §8.10).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from '../index.js';
import { tenantRow } from './plan.js';
import { inTenant, runSeed, seedForTest, type SeedSummary } from './run.js';

import type { IsoTimestamp } from '@blackwing/time';
import type pg from 'pg';

const JUICE = 'http://juice-shop:3000';
let db: PostgresHandle;

const seed = (over: Partial<Parameters<typeof seedForTest>[0]> = {}): Promise<SeedSummary> =>
  seedForTest({ ownerPool: db.ownerPool, appPool: db.appPool, juiceShopUrl: JUICE, ...over });

/** The seeded tenant's id: deterministic, so tests can set the tenant context without reading `tenants`. */
const ACME_ID = tenantRow('2026-01-01T00:00:00.000Z' as IsoTimestamp).id;

/** Runs `fn` on the owner connection with the acme context set (the owner is subject to FORCE RLS too). */
async function asOwnerInAcme<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ACME_ID]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

async function ownerCount(table: string): Promise<number> {
  return asOwnerInAcme(async (client) => {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(rows[0]?.n);
  });
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe('db:seed', () => {
  it('runs every tenant-scoped step now that all seed tables are migrated, and logs no seed.skipped', async () => {
    const skipped: string[] = [];
    const logger = {
      info: (): void => undefined,
      warn: (fields: Record<string, unknown>): void => {
        skipped.push(String(fields.seeder));
      },
    };
    const summary = await runSeed({
      ownerPool: db.ownerPool,
      appPool: db.appPool,
      juiceShopUrl: JUICE,
      logger,
    });
    // The asset tables (ASSET-001) and standing_authorisations (AUTHZ-001) are migrated, so every step runs.
    expect(summary.counts).toEqual({
      tenants: 1,
      users: 6,
      memberships: 5,
      assets: 1,
      asset_credentials: 2,
      standing_authorisations: 1,
      role_matrices: 1,
    });
    expect(skipped).toEqual([]);
  });

  it('populates every entity, all scoped to acme', async () => {
    const summary = await seed({ subjects: { appsec: 'kc-appsec' } });
    expect(summary.counts).toEqual({
      tenants: 1,
      users: 6,
      memberships: 5,
      assets: 1,
      asset_credentials: 2,
      standing_authorisations: 1,
      role_matrices: 1,
    });
    const rows = await inTenant(db.appPool, summary.tenantId, async (tx) => {
      const tables = [
        'memberships',
        'assets',
        'asset_credentials',
        'standing_authorisations',
        'role_matrices',
      ];
      const out: Record<string, unknown[]> = {};
      for (const t of tables) out[t] = (await tx.query(`SELECT * FROM ${t}`)).rows;
      return out;
    });
    for (const [, list] of Object.entries(rows)) {
      for (const row of list)
        expect((row as { tenant_id: string }).tenant_id).toBe(summary.tenantId);
    }
    const tenant = await asOwnerInAcme((client) =>
      client.query("SELECT status, region, plan FROM tenants WHERE slug = 'acme'"),
    );
    expect(tenant.rows).toEqual([{ status: 'active', region: 'eu-west-1', plan: 'dev' }]);
    const operator = await db.ownerPool.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'operator@blackwing.test'",
    );
    expect(
      rows.memberships?.some((m) => (m as { user_id: string }).user_id === operator.rows[0]?.id),
    ).toBe(false);
  });

  it('seeds a verified asset at the local Juice Shop and an active, unexpired SA with SoD', async () => {
    const { tenantId } = await seed();
    await inTenant(db.appPool, tenantId, async (tx) => {
      const asset = await tx.query(
        'SELECT identifiers, verification_status, verification_method FROM assets',
      );
      expect(asset.rows).toEqual([
        {
          identifiers: [{ kind: 'url', value: JUICE }],
          verification_status: 'verified',
          verification_method: 'manual_letter',
        },
      ]);
      const sa = await tx.query<{ status: string; ok: boolean; sod: boolean }>(
        `SELECT status, (valid_from <= now() AND expires_at > now()) AS ok, requester_id <> approver_id AS sod
           FROM standing_authorisations`,
      );
      expect(sa.rows).toEqual([{ status: 'active', ok: true, sod: true }]);
    });
  });

  it('stores credentials as OpenBao secret_ref only', async () => {
    const { tenantId } = await seed();
    const refs = await inTenant(db.appPool, tenantId, (tx) =>
      tx.query<{ secret_ref: string; row: string }>(
        'SELECT secret_ref, row_to_json(c)::text AS row FROM asset_credentials c',
      ),
    );
    expect(refs.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of refs.rows) {
      expect(r.secret_ref).toMatch(/^openbao:\/\/secret\/data\/tenants\/acme\//);
      expect(r.row).not.toMatch(/"password"\s*:\s*"(?!password")/);
    }
  });

  it('is idempotent and converges after a partial run (no duplicate SAs/assets)', async () => {
    await seed();
    // Simulate a partial earlier run: drop some tenant rows (as the owner: the runtime role cannot delete them),
    // then re-seed.
    await asOwnerInAcme(async (client) => {
      await client.query('DELETE FROM role_matrices');
      await client.query('DELETE FROM asset_credentials');
    });
    const again = await seed();
    expect(again.counts).toMatchObject({
      assets: 1,
      standing_authorisations: 1,
      asset_credentials: 2,
      role_matrices: 1,
    });
    expect(await ownerCount('standing_authorisations')).toBe(1);
    const users = await db.ownerPool.query('SELECT count(*)::int AS n FROM users');
    expect(users.rows[0]).toEqual({ n: 6 });
  });

  it('keeps a confirmed Keycloak subject when a later run cannot reach Keycloak', async () => {
    await seed({ subjects: { owner: 'kc-owner' } });
    await seed();
    const r = await db.ownerPool.query(
      "SELECT keycloak_sub FROM users WHERE email = 'owner@acme.test'",
    );
    expect(r.rows).toEqual([{ keycloak_sub: 'kc-owner' }]);
  });

  it('db:seed:reset deletes the seeded rows and recreates them', async () => {
    const before = await seed();
    const after = await seed({ reset: true });
    expect(after.counts).toEqual(before.counts);
  });

  it('renews the SA relative to now, so it is never seeded already expired', async () => {
    const { tenantId } = await seed({
      now: () => new Date(Date.now() + 1_000).toISOString() as IsoTimestamp,
    });
    const r = await inTenant(db.appPool, tenantId, (tx) =>
      tx.query<{ ok: boolean }>('SELECT expires_at > now() AS ok FROM standing_authorisations'),
    );
    expect(r.rows).toEqual([{ ok: true }]);
  });

  it('rejects requester == approver before writing (§8.4)', async () => {
    await expect(seed({ requester: 'owner', approver: 'owner' })).rejects.toThrow(
      /approver must not be the requester/,
    );
  });

  it('shows nothing to another tenant context, and fails closed without one (isolation, §8.6)', async () => {
    await seed();
    const other = newId();
    const counts = await inTenant(db.appPool, other, async (tx) => {
      const out: number[] = [];
      for (const t of [
        'memberships',
        'assets',
        'asset_credentials',
        'standing_authorisations',
        'role_matrices',
      ]) {
        out.push(
          Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n),
        );
      }
      return out;
    });
    expect(counts).toEqual([0, 0, 0, 0, 0]);
    // No tenant context at all: RLS errors out instead of returning rows.
    await expect(db.appPool.query('SELECT count(*) FROM assets')).rejects.toThrow();
    await expect(inTenant(db.appPool, 'acme', () => Promise.resolve(1))).rejects.toThrow(
      /tenant id is required/,
    );
  });
});
