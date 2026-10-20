import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { killEvents, socContacts, socKillTokens } from './kill.js';

const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}.sql`, 'utf8');

describe('kill-switch schema', () => {
  it('every kill table is a tenant table with an RLS policy', () => {
    for (const table of [killEvents, socContacts, socKillTokens]) {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['id', 'tenant_id', 'created_at', 'updated_at']),
      );
      expect(config.policies.map((policy) => policy.name)).toContain(
        `${config.name}_tenant_isolation`,
      );
    }
  });

  it('tenant_id is nullable only on kill_events (global operator events)', () => {
    const notNull = (table: typeof killEvents | typeof socContacts | typeof socKillTokens) =>
      getTableConfig(table).columns.find((column) => column.name === 'tenant_id')?.notNull;
    expect(notNull(killEvents)).toBe(false);
    expect(notNull(socContacts)).toBe(true);
    expect(notNull(socKillTokens)).toBe(true);
  });

  it('stores a token hash, never a raw token column', () => {
    const columns = getTableConfig(socKillTokens).columns.map((column) => column.name);
    expect(columns).toContain('token_sha256');
    expect(columns.filter((column) => column.includes('token'))).toEqual(['token_sha256']);
  });
});

describe('migrations', () => {
  it('are forward-only and ordered', () => {
    expect(migrationNames()).toEqual(['0000_extensions', '0001_kill_switch', '0002_column_mixins']);
    for (const name of migrationNames()) {
      expect(migration(name)).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    }
  });

  it('enable citext before the tables use it', () => {
    expect(migration('0000_extensions')).toContain('CREATE EXTENSION IF NOT EXISTS citext');
  });

  it('force RLS on every kill table (owner included) and keep DELETE from the app role', () => {
    const sql = migration('0001_kill_switch');
    for (const table of ['kill_events', 'soc_contacts', 'soc_kill_tokens']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "${table}" AS PERMISSIVE FOR ALL`,
      );
    }
    expect(sql).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON "kill_events" FROM bw_app');
  });
});
