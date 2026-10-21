import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { SECRETS_NAME_INDEX, secrets, secretVersions } from './secrets.js';

const migrationName = migrationNames().find((name) => name.endsWith('_secrets')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);

const columnNames = (columns: readonly unknown[]): unknown[] =>
  columns.map((c) => (c as { name?: string }).name);

describe('secrets schema', () => {
  const config = getTableConfig(secrets);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      name: true,
      type: false,
      purpose: false,
      backend: true,
      envelope: false,
      external_locator: false,
      current_version: true,
      status: true,
      created_at: true,
      updated_at: true,
    };
    expect(config.name).toBe('secrets');
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('id')?.primary).toBe(true);
    expect(column('backend')?.default).toBe('openbao');
    expect(column('current_version')?.default).toBe(1);
    expect(column('status')?.default).toBe('active');
  });

  it('is unique on (tenant_id, name)', () => {
    const index = config.indexes.find((i) => i.config.name === SECRETS_NAME_INDEX)?.config;
    expect(index?.unique).toBe(true);
    expect(columnNames(index?.columns ?? [])).toEqual(['tenant_id', 'name']);
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['secrets_tenant_isolation']);
  });
});

describe('secret_versions schema', () => {
  const config = getTableConfig(secretVersions);

  it('has the issue columns and a (secret_id, version) key', () => {
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(
      [
        'created_at',
        'envelope',
        'external_locator',
        'retired_at',
        'secret_id',
        'tenant_id',
        'version',
      ].toSorted(),
    );
    expect(columnNames(config.primaryKeys[0]?.columns ?? [])).toEqual(['secret_id', 'version']);
  });

  it('references its secret by (tenant_id, secret_id) so a version cannot cross tenants', () => {
    const fk = config.foreignKeys[0]?.reference();
    expect(columnNames(fk?.columns ?? [])).toEqual(['tenant_id', 'secret_id']);
    expect(columnNames(fk?.foreignColumns ?? [])).toEqual(['tenant_id', 'id']);
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['secret_versions_tenant_isolation']);
  });
});

describe('secrets migration', () => {
  it('exists and is timestamp-named', () => {
    expect(migrationName).toMatch(/^\d{14}_secrets$/);
  });

  it('is forward-only', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it.each(['secrets', 'secret_versions'])(
    'enables and forces RLS on %s with the fail-closed predicate (no missing_ok)',
    (table) => {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "${table}" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`,
      );
    },
  );
  it('never uses current_setting with missing_ok', () => {
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('grants bw_app SELECT/INSERT/UPDATE only: not PUBLIC, no DELETE, no TRUNCATE, no BYPASSRLS', () => {
    expect(migration).toContain('REVOKE ALL ON "secrets", "secret_versions" FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON "secrets" TO bw_app');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON "secret_versions" TO bw_app');
    expect(code).not.toMatch(/GRANT[^;]*(DELETE|TRUNCATE)|BYPASSRLS/i);
  });

  it('constrains name, enums, locator and value presence in the database', () => {
    expect(migration).toContain('IS NFC NORMALIZED');
    expect(migration).toContain("!~ '[[:cntrl:]]'");
    expect(migration).toContain('"secrets_external_locator_check"');
    expect(migration).toContain('"secrets_has_value_check"');
    expect(migration).toContain('"secrets_no_plaintext_check"');
    expect(migration).toContain('"secret_versions_no_plaintext_check"');
  });

  it('documents that the JSON columns never hold plaintext', () => {
    expect(migration).toMatch(/NEVER plaintext/);
  });
});
