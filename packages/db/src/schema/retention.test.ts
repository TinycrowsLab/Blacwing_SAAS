import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { retentionPolicies } from './retention.js';

const migration = (): string => {
  const name = migrationNames().find((tag) => tag.endsWith('_retention_policies'));
  if (!name) throw new Error('retention_policies migration not found');
  return readFileSync(`${MIGRATIONS_DIR}${name}.sql`, 'utf8');
};

describe('retention_policies table', () => {
  it('has the RETAIN-001 columns with the defaults the resolver relies on', () => {
    const config = getTableConfig(retentionPolicies);
    expect(config.columns.map((c) => c.name)).toEqual([
      'id',
      'tenant_id',
      'data_class',
      'retention_days',
      'min_retention_days',
      'legal_hold_overrides',
      'enabled',
      'created_at',
      'updated_at',
    ]);
    const byName = Object.fromEntries(config.columns.map((c) => [c.name, c]));
    expect(byName.legal_hold_overrides?.default).toBe(false);
    expect(byName.enabled?.default).toBe(true);
    expect(byName.tenant_id?.notNull).toBe(true);
  });

  it('is unique per (tenant_id, data_class) and, like the other tenant tables, has no FK to tenants', () => {
    const config = getTableConfig(retentionPolicies);
    expect(config.uniqueConstraints.map((u) => u.name)).toContain(
      'retention_policies_tenant_data_class_key',
    );
    // An FK to `tenants` would be validated under the tenant RLS policy, which needs app.tenant_id: the
    // migration would fail. Tenant isolation is enforced by RLS on every statement instead.
    expect(config.foreignKeys).toHaveLength(0);
  });

  it('migration enables and forces RLS, pins legal hold and grants no DELETE to the runtime role', () => {
    const sql = migration();
    expect(sql).toContain('ALTER TABLE "retention_policies" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "retention_policies" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain(
      `CREATE POLICY "retention_policies_tenant_isolation" ON "retention_policies" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid)`,
    );
    expect(sql).toContain('"legal_hold_overrides" = false');
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON "retention_policies" FROM bw_app');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON "retention_policies" TO bw_app');
    expect(sql).not.toMatch(/CREATE TABLE "(memberships|tenants|users)"/);
    expect(sql).not.toContain('retention_policies_tenant_id_tenants_id_fk');
  });
});
