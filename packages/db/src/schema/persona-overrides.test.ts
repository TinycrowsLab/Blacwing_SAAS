import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { personaOverrides, PERSONA_OVERRIDE_EFFORT_VALUES } from './persona-overrides.js';

const migrationName = migrationNames().find((name) => name.endsWith('_persona_overrides')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('persona_overrides schema', () => {
  const config = getTableConfig(personaOverrides);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has exactly the whitelisted columns plus the key and updated_at', () => {
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(
      [
        'effort',
        'lower_standard_tier',
        'max_budget_usd',
        'max_turns',
        'persona',
        'tenant_id',
        'updated_at',
      ].toSorted(),
    );
  });

  it('keys one row per (tenant_id, persona)', () => {
    const key = config.primaryKeys[0];
    expect(key?.columns.map((c) => c.name)).toEqual(['tenant_id', 'persona']);
  });

  it('marks the identity columns NOT NULL and the overrides nullable (absent means base)', () => {
    expect(column('tenant_id')?.notNull).toBe(true);
    expect(column('persona')?.notNull).toBe(true);
    expect(column('updated_at')?.notNull).toBe(true);
    for (const name of ['effort', 'max_turns', 'max_budget_usd', 'lower_standard_tier']) {
      expect(column(name)?.notNull, name).toBe(false);
    }
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['persona_overrides_tenant_isolation']);
  });

  it('checks effort against the exported level list the API validates with', () => {
    expect(PERSONA_OVERRIDE_EFFORT_VALUES).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(code).toContain(
      `"persona_overrides"."effort" IN ('low', 'medium', 'high', 'xhigh', 'max')`,
    );
  });

  it('keeps the persona name check to lowercase kebab-case', () => {
    const pattern = /^[a-z][a-z0-9-]{0,63}$/;
    expect(pattern.test('sub-planner')).toBe(true);
    expect(pattern.test('Planner')).toBe(false);
    expect(pattern.test('x'.repeat(65))).toBe(false);
  });
});

describe('persona_overrides migration', () => {
  it('creates the table with its checks and forces RLS', () => {
    expect(migrationName).not.toBe('');
    expect(code).toContain('CREATE TABLE "persona_overrides"');
    expect(code).toContain('ALTER TABLE "persona_overrides" ENABLE ROW LEVEL SECURITY');
    expect(code).toContain('ALTER TABLE "persona_overrides" FORCE ROW LEVEL SECURITY');
    expect(code).toContain('CREATE POLICY "persona_overrides_tenant_isolation"');
    expect(code).toContain("current_setting('app.tenant_id')::uuid");
    expect(code).toContain('"persona_overrides_max_turns_check"');
    expect(code).toContain('"persona_overrides_max_budget_check"');
  });

  it('grants the runtime role no DELETE or TRUNCATE', () => {
    expect(code).toContain('REVOKE ALL ON "persona_overrides" FROM PUBLIC');
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "persona_overrides" FROM bw_app');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "persona_overrides" TO bw_app');
    expect(code).not.toMatch(/GRANT[^;]*DELETE[^;]*TO bw_app/);
  });

  it('does not re-create the tenancy tables (generated from the latest snapshot)', () => {
    expect(code).not.toContain('CREATE TABLE "tenants"');
    expect(code).not.toContain('CREATE TABLE "memberships"');
  });
});
