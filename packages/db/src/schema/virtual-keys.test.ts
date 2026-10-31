import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { virtualKeys, VIRTUAL_KEY_RESOLVE_SETTING } from './virtual-keys.js';

const migrationName = migrationNames().find((name) => name.endsWith('_virtual_keys')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('virtual_keys schema', () => {
  const config = getTableConfig(virtualKeys);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has the GATEWAY-002 columns: scope, hash and prefix, budget context, expiry and revocation', () => {
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(
      [
        'budget_context',
        'created_at',
        'expires_at',
        'id',
        'key_prefix',
        'key_sha256',
        'last_used_at',
        'persona',
        'revoked_at',
        'run_id',
        'scope',
        'session_id',
        'tenant_id',
        'updated_at',
      ].toSorted(),
    );
  });

  it('marks identity, hash, expiry and tenant NOT NULL; revocation and last use nullable', () => {
    for (const name of ['tenant_id', 'run_id', 'session_id', 'key_sha256', 'expires_at']) {
      expect(column(name)?.notNull, name).toBe(true);
    }
    expect(column('revoked_at')?.notNull).toBe(false);
    expect(column('last_used_at')?.notNull).toBe(false);
  });

  it('carries the canonical tenant policy plus the hash-gated resolve policy', () => {
    expect(config.policies.map((p) => p.name).toSorted()).toEqual(
      ['virtual_keys_resolve_by_hash', 'virtual_keys_tenant_isolation'].toSorted(),
    );
    expect(VIRTUAL_KEY_RESOLVE_SETTING).toBe('app.virtual_key_sha256');
  });

  it('keeps the migration in step with the schema: tenant isolation, forced RLS and the hash check', () => {
    expect(migrationName).not.toBe('');
    expect(code).toContain('CREATE TABLE "virtual_keys"');
    expect(code).toContain('ALTER TABLE "virtual_keys" ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('ALTER TABLE "virtual_keys" FORCE ROW LEVEL SECURITY');
    expect(code).toContain('CREATE POLICY "virtual_keys_tenant_isolation"');
    expect(code).toContain("current_setting('app.tenant_id')::uuid");
    expect(code).toContain('CREATE POLICY "virtual_keys_resolve_by_hash"');
    expect(code).toContain("current_setting('app.virtual_key_sha256', true)");
    expect(code).toContain('octet_length("virtual_keys"."key_sha256") = 32');
  });

  it('gives the runtime role no DELETE or TRUNCATE', () => {
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "virtual_keys" FROM bw_app');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "virtual_keys" TO bw_app');
    expect(code).not.toMatch(/GRANT[^;]*DELETE[^;]*TO bw_app/);
  });
});
