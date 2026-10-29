// The asset inventory (ASSET-001): tenant isolation, fail-closed context, the CHECK and UNIQUE constraints,
// the composite foreign keys and the runtime role's privileges, against the real migrations on Postgres 16
// (Testcontainers). Run with `pnpm test:int`.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import {
  expectFailsClosedWithoutContext,
  expectRlsBlocksCrossTenant,
  type PostgresHandle,
  withPostgres,
} from '@blackwing/testing/containers';

import { publicId } from './columns.js';
import { migrateDatabase } from './index.js';

let db: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const ownerA = newId();

/** Postgres error code of a rejected promise (23514 check, 23505 unique, 23503 FK, 42501 privilege). */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof pg.DatabaseError ? error.code : 'not-a-database-error';
  }
  return undefined;
}

const identifiers = JSON.stringify([{ kind: 'url', value: 'https://app.example.test' }]);

/** An asset in `tenantId`, inserted under that tenant's context. Returns its id. */
async function createAsset(
  tenantId: string,
  overrides: { verification?: 'unverified' | 'verified'; identifiers?: string } = {},
): Promise<string> {
  const id = newId();
  await db.withTenant(tenantId, (tx) =>
    tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id,
         verification_status, verification_method, verified_at)
       VALUES ($1, $2, $3, 'web_app', 'Shop', $4::jsonb, 'staging', $5, $6, $7, $8)`,
      [
        id,
        tenantId,
        publicId('asset', id),
        overrides.identifiers ?? identifiers,
        ownerA,
        overrides.verification ?? 'unverified',
        overrides.verification === 'verified' ? 'dns_txt' : null,
        overrides.verification === 'verified' ? new Date() : null,
      ],
    ),
  );
  return id;
}

beforeAll(async () => {
  db = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await db.ownerPool.query(`INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)`, [
    ownerA,
    `asset-owner-${ownerA}`,
    `asset-owner-${ownerA}@example.test`,
  ]);
}, 180_000);

afterAll(async () => {
  // beforeAll may have failed before the handle existed; do not mask that error with a teardown TypeError.
  await (db as PostgresHandle | undefined)?.stop();
});

describe('asset tenant isolation (assets.rls.cross-tenant)', () => {
  it('tenant B cannot read, update or soft-delete tenant A asset', async () => {
    const assetA = await createAsset(tenantA);
    const seen = await db.withTenant(tenantB, (tx) =>
      tx.query('SELECT id FROM assets WHERE id = $1', [assetA]),
    );
    expect(seen.rowCount).toBe(0);
    const updated = await db.withTenant(tenantB, (tx) =>
      tx.query(`UPDATE assets SET deleted_at = now() WHERE id = $1`, [assetA]),
    );
    expect(updated.rowCount).toBe(0);
    const stillLive = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT deleted_at FROM assets WHERE id = $1', [assetA]),
    );
    expect(stillLive.rows[0]).toEqual({ deleted_at: null });
  });

  it('tenant B cannot insert an asset under tenant A', async () => {
    const id = newId();
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id)
           VALUES ($1, $2, $3, 'web_app', 'Smuggled', $4::jsonb, 'dev', $5)`,
          [id, tenantA, publicId('asset', id), identifiers, ownerA],
        ),
      ),
    );
    expect(code).toBe('42501');
  });

  it('a credential cannot reference another tenant asset (composite foreign key)', async () => {
    const assetA = await createAsset(tenantA);
    const code = await pgCode(
      db.withTenant(tenantB, (tx) =>
        tx.query(
          `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
           VALUES ($1, $2, $3, 'customer', 'openbao://secret/data/tenants/b/customer', '{}'::jsonb, 'none')`,
          [newId(), tenantB, assetA],
        ),
      ),
    );
    expect(code).toBe('23503');
  });

  it('RLS blocks cross-tenant reads and writes on the asset table', async () => {
    await expect(
      expectRlsBlocksCrossTenant(db.appPool, 'assets', {
        tenantA,
        tenantB,
        insertRow: async (tx, tenantId) => {
          const id = newId();
          await tx.query(
            `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id)
             VALUES ($1, $2, $3, 'web_app', 'Iso', $4::jsonb, 'dev', $5)`,
            [id, tenantId, publicId('asset', id), identifiers, ownerA],
          );
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('fails closed (raises) without a tenant context', async () => {
    await expect(expectFailsClosedWithoutContext(db.appPool, 'assets')).resolves.toBeUndefined();
    await expect(
      expectFailsClosedWithoutContext(db.appPool, 'asset_credentials'),
    ).resolves.toBeUndefined();
  });
});

describe('asset constraints', () => {
  it('keeps one credential per (asset, role)', async () => {
    const assetId = await createAsset(tenantA);
    const insert = (role: string) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
           VALUES ($1, $2, $3, $4, 'openbao://secret/data/tenants/a/customer', '{}'::jsonb, 'totp')`,
          [newId(), tenantA, assetId, role],
        ),
      );
    await insert('customer');
    expect(await pgCode(insert('customer'))).toBe('23505');
    await expect(insert('admin')).resolves.toBeDefined();
  });

  it('rejects an identifiers array over 64 KiB', async () => {
    const big = JSON.stringify([
      { kind: 'url', value: `https://a.example.test/${'x'.repeat(70_000)}` },
    ]);
    expect(await pgCode(createAsset(tenantA, { identifiers: big }))).toBe('23514');
  });

  it('rejects an empty or non-array identifiers value', async () => {
    expect(await pgCode(createAsset(tenantA, { identifiers: '[]' }))).toBe('23514');
    expect(await pgCode(createAsset(tenantA, { identifiers: '{"kind":"url"}' }))).toBe('23514');
  });

  it('rejects a verified asset without a verification method and time', async () => {
    const id = newId();
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id, verification_status)
           VALUES ($1, $2, $3, 'web_app', 'Unproven', $4::jsonb, 'dev', $5, 'verified')`,
          [id, tenantA, publicId('asset', id), identifiers, ownerA],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('accepts a verified asset that records its method and time', async () => {
    const id = await createAsset(tenantA, { verification: 'verified' });
    const row = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT verification_status FROM assets WHERE id = $1', [id]),
    );
    expect(row.rows[0]).toEqual({ verification_status: 'verified' });
  });

  it('refuses a plaintext-looking secret reference', async () => {
    const assetId = await createAsset(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
           VALUES ($1, $2, $3, 'guest', 'hunter2 is my password', '{}'::jsonb, 'none')`,
          [newId(), tenantA, assetId],
        ),
      ),
    );
    expect(code).toBe('23514');
  });

  it('keeps one active role matrix per asset', async () => {
    const assetId = await createAsset(tenantA);
    const insert = (version: number) =>
      db.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix, active)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, true)`,
          [newId(), tenantA, assetId, version],
        ),
      );
    await insert(1);
    expect(await pgCode(insert(2))).toBe('23505');
  });

  it('bumps updated_at on every write', async () => {
    const id = await createAsset(tenantA);
    const before = await db.withTenant(tenantA, (tx) =>
      tx.query<{ updated_at: Date }>('SELECT updated_at FROM assets WHERE id = $1', [id]),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await db.withTenant(tenantA, (tx) =>
      tx.query<{ updated_at: Date }>(
        `UPDATE assets SET name = 'Renamed' WHERE id = $1 RETURNING updated_at`,
        [id],
      ),
    );
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(
      before.rows[0]?.updated_at.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe('asset runtime privileges', () => {
  it('the runtime role cannot hard-delete an asset (retire by soft delete)', async () => {
    const id = await createAsset(tenantA);
    const code = await pgCode(
      db.withTenant(tenantA, (tx) => tx.query('DELETE FROM assets WHERE id = $1', [id])),
    );
    expect(code).toBe('42501');
  });

  it('the runtime role cannot hard-delete a role matrix version', async () => {
    const assetId = await createAsset(tenantA);
    const matrixId = newId();
    await db.withTenant(tenantA, (tx) =>
      tx.query(
        `INSERT INTO role_matrices (id, tenant_id, asset_id, version, matrix) VALUES ($1, $2, $3, 1, '{}'::jsonb)`,
        [matrixId, tenantA, assetId],
      ),
    );
    const code = await pgCode(
      db.withTenant(tenantA, (tx) =>
        tx.query('DELETE FROM role_matrices WHERE id = $1', [matrixId]),
      ),
    );
    expect(code).toBe('42501');
  });

  it('the runtime role may soft-delete an asset', async () => {
    const id = await createAsset(tenantA);
    const updated = await db.withTenant(tenantA, (tx) =>
      tx.query('UPDATE assets SET deleted_at = now() WHERE id = $1', [id]),
    );
    expect(updated.rowCount).toBe(1);
  });
});
