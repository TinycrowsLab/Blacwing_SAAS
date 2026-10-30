import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { SA_PUBLIC_ID_KEY, standingAuthorisations } from './authorisation.js';

const migrationName =
  migrationNames().find((name) => name.endsWith('_standing_authorisations')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);

const columnNames = (columns: readonly unknown[]): unknown[] =>
  columns.map((c) => (c as { name?: string }).name);

describe('standing_authorisations schema', () => {
  const config = getTableConfig(standingAuthorisations);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability and defaults', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      public_id: true,
      asset_ids: true,
      scope_rules: true,
      max_intrusiveness: true,
      pre_approved_test_classes: true,
      default_budgets: true,
      test_windows: true,
      valid_from: true,
      expires_at: true,
      requester_id: true,
      approver_id: false,
      signature: false,
      signing_key_id: false,
      envelope_hash: false,
      version: true,
      status: true,
      revocation_reason: false,
      created_at: true,
      updated_at: true,
    };
    expect(config.name).toBe('standing_authorisations');
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('id')?.primary).toBe(true);
    expect(column('version')?.default).toBe(1);
    expect(column('status')?.default).toBe('draft');
  });

  it('keeps the public id unique', () => {
    expect(config.uniqueConstraints.map((u) => u.name)).toContain(SA_PUBLIC_ID_KEY);
  });

  it('indexes tenant, status, expiry and asset ids (GIN)', () => {
    const indexes = config.indexes.map((i) => i.config);
    expect(indexes.map((i) => i.name).toSorted()).toEqual(
      [
        'standing_authorisations_asset_ids_gin_idx',
        'standing_authorisations_expires_at_idx',
        'standing_authorisations_status_idx',
        'standing_authorisations_tenant_id_idx',
      ].toSorted(),
    );
    const gin = indexes.find((i) => i.name === 'standing_authorisations_asset_ids_gin_idx');
    expect(gin?.method).toBe('gin');
    expect(columnNames(gin?.columns ?? [])).toEqual(['asset_ids']);
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual([
      'standing_authorisations_tenant_isolation',
    ]);
  });
});

describe('standing_authorisations migration', () => {
  it('exists and is timestamp-named', () => {
    expect(migrationName).toMatch(/^\d{14}_standing_authorisations$/);
  });

  it('is forward-only', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('enables and forces RLS with the fail-closed predicate (no missing_ok)', () => {
    expect(migration).toContain('ALTER TABLE "standing_authorisations" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "standing_authorisations" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain(
      `CREATE POLICY "standing_authorisations_tenant_isolation" ON "standing_authorisations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`,
    );
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('grants bw_app SELECT/INSERT/UPDATE only: never PUBLIC DML, no DELETE, no TRUNCATE, no BYPASSRLS', () => {
    expect(code).toContain('REVOKE ALL ON "standing_authorisations" FROM PUBLIC');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "standing_authorisations" TO bw_app');
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "standing_authorisations" FROM bw_app');
    expect(code).not.toMatch(/GRANT[^;]*(DELETE|TRUNCATE)|BYPASSRLS/i);
  });

  it('refuses a destructive ceiling and an inverted or empty window in the database', () => {
    expect(migration).toContain(
      `"max_intrusiveness" IN ('passive', 'active_safe', 'state_changing')`,
    );
    expect(migration).not.toContain("'destructive'");
    expect(migration).toContain('"standing_authorisations_window_check"');
    expect(migration).toContain('"standing_authorisations_asset_ids_check"');
    expect(migration).toContain('cardinality("standing_authorisations"."asset_ids") >= 1');
  });

  it('keeps updated_at in step with the database trigger', () => {
    expect(code).toContain(
      'CREATE TRIGGER standing_authorisations_set_updated_at BEFORE UPDATE ON standing_authorisations FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at()',
    );
  });
});
