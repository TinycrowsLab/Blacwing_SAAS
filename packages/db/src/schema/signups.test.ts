import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { signups } from './signups.js';

const migrationName = migrationNames().find((name) => name.endsWith('_signups')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('signups table', () => {
  const config = getTableConfig(signups);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has the TENANT-004 columns with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      email: true,
      org_name: true,
      desired_slug: false,
      token_hash: true,
      expires_at: true,
      status: true,
      created_at: true,
      updated_at: true,
    };
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('email')?.getSQLType()).toBe('citext');
    expect(column('status')?.default).toBe('pending');
  });

  it('is not a tenant table: no tenant_id and no RLS policy (there is no tenant before verification)', () => {
    expect(column('tenant_id')).toBeUndefined();
    expect(config.policies).toEqual([]);
    expect(code).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY/i);
  });

  it('makes the token hash unique and constrains status and the hash shape', () => {
    expect(config.uniqueConstraints.map((u) => u.name)).toEqual(['signups_token_hash_key']);
    expect(config.checks.map((c) => c.name).toSorted()).toEqual([
      'signups_status_check',
      'signups_token_hash_check',
    ]);
    expect(code).toContain("IN ('pending', 'verified', 'expired', 'cancelled')");
  });

  it('indexes the per-address request throttle', () => {
    expect(config.indexes.map((i) => i.config.name)).toEqual(['signups_email_created_at_idx']);
  });

  it('grants DML to the runtime role only and keeps updated_at in the database', () => {
    expect(code).toContain('REVOKE ALL ON "signups" FROM PUBLIC');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "signups" TO bw_app');
    expect(code).toContain('CREATE TRIGGER signups_set_updated_at BEFORE UPDATE ON signups');
  });
});
