// db:seed against Postgres 16 (Testcontainers) with the real migrations, then the §7 seed tables
// (test fixture until the domain migrations land): fail-fast preflight, population, idempotency,
// reset, SoD, secret refs, tenant scoping under RLS and cross-tenant isolation (§8.4, §8.6, §8.7, §8.10).

import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { migrateDatabase } from '../index.js';
import { inTenant, runSeed, type SeedSummary } from './run.js';
import { SeedPreflightError } from './schema-contract.js';

import type { IsoTimestamp } from '@blackwing/time';

const FIXTURE = new URL('./__fixtures__/seed-tables.sql', import.meta.url);
const JUICE = 'http://127.0.0.1:13000';
let db: PostgresHandle;

const seed = (over: Partial<Parameters<typeof runSeed>[0]> = {}): Promise<SeedSummary> =>
  runSeed({ ownerPool: db.ownerPool, appPool: db.appPool, juiceShopUrl: JUICE, ...over });

async function ownerCount(table: string): Promise<number> {
  const client = await db.ownerPool.connect();
  try {
    await client.query('BEGIN');
    // The owner is subject to FORCE RLS on tenant tables: count with the acme context set.
    const t = await client.query<{ id: string }>("SELECT id FROM tenants WHERE slug = 'acme'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.rows[0]?.id ?? newId()]);
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    await client.query('COMMIT');
    return Number(rows[0]?.n);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
}, 180_000);

afterAll(async () => {
  await db.stop();
});

describe('db:seed', () => {
  it('fails fast with guidance when the migrations are not applied', async () => {
    const error = await seed().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedPreflightError);
    expect((error as SeedPreflightError).message).toMatch(/pnpm db:migrate/);
    expect((error as SeedPreflightError).problems).toContain('table tenants does not exist');
    // Nothing was created by the failed run.
    const { rows } = await db.ownerPool.query("SELECT to_regclass('tenants') AS t");
    expect(rows[0]).toEqual({ t: null });
  });

  it('populates every entity, all scoped to acme', async () => {
    await db.ownerPool.query(await readFile(FIXTURE, 'utf8'));
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
    const tenant = await db.ownerPool.query(
      "SELECT status, region, plan FROM tenants WHERE slug = 'acme'",
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
          identifiers: [JUICE],
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
    // Simulate a partial earlier run: drop some tenant rows, then re-seed.
    const t = await db.ownerPool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = 'acme'",
    );
    const tenantId = t.rows[0]?.id ?? '';
    await inTenant(db.appPool, tenantId, async (tx) => {
      await tx.query('DELETE FROM role_matrices');
      await tx.query('DELETE FROM asset_credentials');
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

  it('rejects requester == approver before writing, and the DB check rejects it too (§8.4)', async () => {
    await expect(seed({ requester: 'owner', approver: 'owner' })).rejects.toThrow(
      /approver must not be the requester/,
    );
    const t = await db.ownerPool.query<{ id: string }>(
      "SELECT id FROM tenants WHERE slug = 'acme'",
    );
    const code = await inTenant(db.appPool, t.rows[0]?.id ?? '', (tx) =>
      tx.query('UPDATE standing_authorisations SET approver_id = requester_id'),
    ).then(
      () => 'ok',
      (e: unknown) => (e instanceof pg.DatabaseError ? e.code : 'other'),
    );
    expect(code).toBe('23514');
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
