import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ASSET_JSON_MAX_BYTES } from '@blackwing/contracts';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import {
  assetCredentials,
  assetGroupMembers,
  assetGroups,
  assetTags,
  assets,
  roleMatrices,
} from './assets.js';

const migrationName = migrationNames().find((name) => name.endsWith('_asset_inventory')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

/** Every tenant table of the inventory: each one carries the tenant policy, FORCE RLS and updated_at. */
const TENANT_TABLES = [
  'assets',
  'asset_credentials',
  'role_matrices',
  'asset_tags',
  'asset_groups',
  'asset_group_members',
] as const;

describe('asset inventory schema', () => {
  it('has every column of the issue, with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      public_id: true,
      type: true,
      name: true,
      identifiers: true,
      environment: true,
      owner_user_id: true,
      verification_status: true,
      verification_method: false,
      verified_at: false,
      verification_expires_at: false,
      attestation: false,
      state_version: true,
      idempotency_key: false,
      idempotency_fingerprint: false,
      deleted_at: false,
      created_at: true,
      updated_at: true,
    };
    const config = getTableConfig(assets);
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(config.columns.find((c) => c.name === name)?.notNull, name).toBe(notNull);
    }
  });

  it('gives every table the tenant column, a timestamp pair and the tenant policy', () => {
    const tables = [assetCredentials, roleMatrices, assetTags, assetGroups, assetGroupMembers];
    for (const table of tables) {
      const config = getTableConfig(table);
      const names = config.columns.map((c) => c.name);
      expect(names, config.name).toContain('tenant_id');
      expect(names, config.name).toEqual(expect.arrayContaining(['created_at', 'updated_at']));
      expect(
        config.policies.map((p) => p.name),
        config.name,
      ).toEqual([`${config.name}_tenant_isolation`]);
    }
  });

  it('keys a credential by (asset_id, role_name) and stores a reference, never a value', () => {
    const config = getTableConfig(assetCredentials);
    expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual([
      'asset_id',
      'role_name',
    ]);
    expect(config.columns.find((c) => c.name === 'secret_ref')?.notNull).toBe(true);
    const names = config.columns.map((c) => c.name);
    expect(names).not.toContain('secret');
    expect(names).not.toContain('password');
  });

  it('keys tags by (tenant, asset, key) and group members by (tenant, group, asset)', () => {
    expect(getTableConfig(assetTags).primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'asset_id',
      'key',
    ]);
    expect(getTableConfig(assetGroupMembers).primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'group_id',
      'asset_id',
    ]);
  });

  it('indexes the live-asset lookup and the identifiers GIN index', () => {
    const indexes = getTableConfig(assets).indexes.map((i) => i.config.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['assets_live_tenant_type_idx', 'assets_identifiers_gin_idx']),
    );
  });
});

describe('asset inventory migration', () => {
  it('is named descriptively, not auto-generated', () => {
    expect(migrationName).not.toBe('');
    expect(migrationName).toMatch(/_asset_inventory$/);
  });

  it.each(TENANT_TABLES)('%s has RLS enabled and FORCED with the tenant policy', (table) => {
    expect(code).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    expect(code).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    expect(code).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
  });

  it.each(TENANT_TABLES)('%s has an updated_at trigger', (table) => {
    expect(code).toContain(
      `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at()`,
    );
  });

  it('enforces the tenant predicate with no missing_ok fallback', () => {
    expect(code).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(code).not.toContain('missing_ok');
  });

  it('caps every jsonb column at the 64 KiB the contracts enforce', () => {
    expect(ASSET_JSON_MAX_BYTES).toBe(65_536);
    expect(code).toContain(
      '"assets_identifiers_size_check" CHECK (octet_length("assets"."identifiers"::text) <= 65536)',
    );
    expect(code).toContain('"assets_attestation_check"');
    expect(code).toContain('"asset_credentials_login_recipe_check"');
    expect(code).toContain('"role_matrices_matrix_check"');
  });

  it('stores a secret as an OpenBao reference only', () => {
    expect(code).toContain(
      `"asset_credentials_secret_ref_check" CHECK (starts_with("asset_credentials"."secret_ref", 'openbao://')`,
    );
  });

  it('makes a verified asset record how and when it was verified', () => {
    expect(code).toContain(
      `"assets_verified_evidence_check" CHECK ("assets"."verification_status" <> 'verified' OR ("assets"."verification_method" IS NOT NULL AND "assets"."verified_at" IS NOT NULL))`,
    );
  });

  it('refuses a role matrix version below 1 and allows one active matrix per asset', () => {
    expect(code).toContain('"role_matrices_version_check" CHECK ("role_matrices"."version" >= 1)');
    expect(code).toContain(
      'CREATE UNIQUE INDEX "role_matrices_one_active_per_asset_key" ON "role_matrices" USING btree ("asset_id") WHERE "role_matrices"."active"',
    );
  });

  it('indexes live assets with a partial index that skips soft-deleted rows', () => {
    expect(code).toContain(
      'CREATE INDEX "assets_live_tenant_type_idx" ON "assets" USING btree ("tenant_id","type") WHERE "assets"."deleted_at" IS NULL',
    );
    expect(code).toContain(
      'CREATE INDEX "assets_identifiers_gin_idx" ON "assets" USING gin ("identifiers")',
    );
  });

  it('binds every child row to its parent with a composite (tenant_id, id) foreign key', () => {
    expect(code).toContain(
      'FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id")',
    );
    expect(code).toContain(
      'FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."asset_groups"("tenant_id","id")',
    );
  });

  it('never grants the runtime role DELETE on assets or role matrices (soft delete and versions)', () => {
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "assets", "role_matrices" FROM bw_app');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "assets", "role_matrices" TO bw_app');
    expect(code).not.toMatch(/GRANT[^;]*DELETE[^;]*"assets"[^;]*TO bw_app/);
    expect(code).not.toMatch(/GRANT[^;]*DELETE[^;]*"role_matrices"[^;]*TO bw_app/);
  });
});
