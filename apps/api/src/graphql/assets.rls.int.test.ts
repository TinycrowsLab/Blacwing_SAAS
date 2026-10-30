// GraphQL asset reads against real Postgres (ASSET read model, API-009): RLS and the explicit tenant filter confine
// every batch to the caller's tenant, soft-deleted assets are absent, credential roles carry no login recipe, and a
// foreign id reads as absent. Needs Docker (Testcontainers); run with `pnpm test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgAssetReadStore } from './postgres.js';

import type { AssetFilter } from './store.js';

let handle: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const ownerA = newId();
const ownerB = newId();
const assetA = newId();
const assetADeleted = newId();
const assetB = newId();
const groupA = newId();

const identifiers = JSON.stringify([{ kind: 'url', value: 'https://app.acme.test' }]);

/** Runs one insert under a tenant's context (the app role, so RLS applies to the seed too). */
async function inTenant(tenantId: string, sql: string, params: unknown[]): Promise<void> {
  await handle.withTenant(tenantId, (tx) => tx.query(sql, params));
}

async function seedTenant(id: string, slug: string, owner: string): Promise<void> {
  await inTenant(id, 'INSERT INTO tenants (id, slug, name, region) VALUES ($1, $2, $3, $4)', [
    id,
    slug,
    slug,
    'eu-west-1',
  ]);
  await handle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [owner, `sub-${owner}`, `${owner}@assets.test`, 'Owner'],
  );
  await inTenant(id, 'INSERT INTO memberships (tenant_id, user_id, roles) VALUES ($1, $2, $3)', [
    id,
    owner,
    ['developer'],
  ]);
}

async function seedAsset(
  id: string,
  tenantId: string,
  owner: string,
  name: string,
  deleted = false,
): Promise<void> {
  await inTenant(
    tenantId,
    `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id,
       verification_status, verification_method, verified_at, deleted_at)
     VALUES ($1, $2, $3, 'web_app', $4, $5::jsonb, 'staging', $6, 'verified', 'dns_txt', now(), $7)`,
    [
      id,
      tenantId,
      `asset_${id.replaceAll('-', '').slice(-20)}`,
      name,
      identifiers,
      owner,
      deleted ? new Date() : null,
    ],
  );
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await seedTenant(tenantA, 'acme-assets-gql', ownerA);
  await seedTenant(tenantB, 'beta-assets-gql', ownerB);
  await seedAsset(assetA, tenantA, ownerA, 'Shop');
  await seedAsset(assetADeleted, tenantA, ownerA, 'Retired', true);
  await seedAsset(assetB, tenantB, ownerB, 'Foreign');
  await inTenant(
    tenantA,
    'INSERT INTO asset_tags (tenant_id, asset_id, key, value) VALUES ($1, $2, $3, $4)',
    [tenantA, assetA, 'env', 'staging'],
  );
  await inTenant(tenantA, 'INSERT INTO asset_groups (id, tenant_id, name) VALUES ($1, $2, $3)', [
    groupA,
    tenantA,
    'Payments',
  ]);
  await inTenant(
    tenantA,
    'INSERT INTO asset_group_members (tenant_id, group_id, asset_id) VALUES ($1, $2, $3)',
    [tenantA, groupA, assetA],
  );
  await inTenant(
    tenantA,
    `INSERT INTO asset_credentials (id, tenant_id, asset_id, role_name, secret_ref, login_recipe, mfa_type)
     VALUES ($1, $2, $3, 'admin', 'openbao://kv/shop/admin', '{"steps":["fill user"]}'::jsonb, 'totp')`,
    [newId(), tenantA, assetA],
  );
});

afterAll(async () => {
  await handle.stop();
});

describe('asset read store over Postgres (RLS)', () => {
  it("lists only the caller tenant's live assets", async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    const rows = await store.listAssets(tenantA, { filter: {}, limit: 50 });
    expect(rows.map((row) => row.id)).toEqual([assetA]);
    expect(rows.map((row) => row.id)).not.toContain(assetB);
    expect(rows.map((row) => row.id)).not.toContain(assetADeleted);
  });

  it('finds one asset by uuid or public id, and a foreign or deleted one as absent', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    const own = await store.findAsset(tenantA, assetA);
    expect(own?.name).toBe('Shop');
    const publicId = own?.publicId ?? '';
    expect((await store.findAsset(tenantA, publicId))?.id).toBe(assetA);
    expect(await store.findAsset(tenantA, assetB)).toBeUndefined();
    expect(await store.findAsset(tenantA, assetADeleted)).toBeUndefined();
    expect(await store.findAsset(tenantB, assetA)).toBeUndefined();
  });

  it('reads tags, groups and credential roles only for the caller tenant, without the login recipe', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    const tags = await store.tagsOf(tenantA, [assetA, assetB]);
    expect(tags.get(assetA)).toEqual([{ key: 'env', value: 'staging' }]);
    expect(tags.has(assetB)).toBe(false);

    const groups = await store.groupsOf(tenantA, [assetA]);
    expect(groups.get(assetA)).toEqual([{ id: groupA, name: 'Payments' }]);

    const roles = await store.credentialRolesOf(tenantA, [assetA]);
    const role = roles.get(assetA)?.[0];
    expect(role).toEqual({
      roleName: 'admin',
      mfaType: 'totp',
      secretRef: 'openbao://kv/shop/admin',
    });
    expect(JSON.stringify(roles)).not.toContain('fill user');

    expect((await store.credentialRolesOf(tenantB, [assetA])).size).toBe(0);
    expect((await store.tagsOf(tenantB, [assetA])).size).toBe(0);
  });

  it('answers empty for an empty batch without touching the database', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    expect((await store.tagsOf(tenantA, [])).size).toBe(0);
    expect((await store.groupsOf(tenantA, [])).size).toBe(0);
    expect((await store.credentialRolesOf(tenantA, [])).size).toBe(0);
  });

  it('resolves the roles of a user only in the same tenant', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    expect(await store.rolesOf(tenantA, ownerA)).toEqual(['developer']);
    expect(await store.rolesOf(tenantB, ownerA)).toEqual([]);
  });

  it('filters by tag key and value, and by group name, inside the caller tenant only', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    const ids = async (tenantId: string, filter: AssetFilter) =>
      (await store.listAssets(tenantId, { filter, limit: 50 })).map((row) => row.id);
    expect(await ids(tenantA, { tagKey: 'env' })).toEqual([assetA]);
    expect(await ids(tenantA, { tagKey: 'env', tagValue: 'staging' })).toEqual([assetA]);
    expect(await ids(tenantA, { tagKey: 'env', tagValue: 'prod' })).toEqual([]);
    expect(await ids(tenantA, { tagKey: 'team' })).toEqual([]);
    expect(await ids(tenantA, { group: 'Payments' })).toEqual([assetA]);
    expect(await ids(tenantA, { group: 'Unknown' })).toEqual([]);
    // Tenant B holds neither the tag nor the group, so the same filter reads nothing there.
    expect(await ids(tenantB, { tagKey: 'env' })).toEqual([]);
    expect(await ids(tenantB, { group: 'Payments' })).toEqual([]);
  });

  it('fails closed without a valid tenant id', async () => {
    const store = createPgAssetReadStore(createDatabase(handle.appPool));
    await expect(store.listAssets('not-a-tenant', { filter: {}, limit: 5 })).rejects.toThrow();
  });
});
