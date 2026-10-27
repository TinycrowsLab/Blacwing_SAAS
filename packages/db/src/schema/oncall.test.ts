import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { oncallMembers, oncallRosters, oncallSchedules } from './oncall.js';

const TABLES = [oncallRosters, oncallMembers, oncallSchedules] as const;

const migrationName = migrationNames().find((name) => name.endsWith('_oncall_rosters')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);

const columnNames = (columns: readonly unknown[]): unknown[] =>
  columns.map((c) => (c as { name?: string }).name);

describe('oncall schema', () => {
  it('every table is tenant scoped with the canonical tenant policy', () => {
    for (const table of TABLES) {
      const config = getTableConfig(table);
      const tenant = config.columns.find((column) => column.name === 'tenant_id');
      expect(tenant?.notNull, config.name).toBe(true);
      expect(config.policies.map((policy) => policy.name)).toEqual([
        `${config.name}_tenant_isolation`,
      ]);
      expect(columnNames(config.columns)).toEqual(
        expect.arrayContaining(['id', 'created_at', 'updated_at']),
      );
    }
  });

  it('rosters carry the IANA zone and a state_version for the ETag', () => {
    const names = getTableConfig(oncallRosters).columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(['name', 'timezone', 'active', 'state_version']));
  });

  it('allows one active roster per tenant', () => {
    const index = getTableConfig(oncallRosters).indexes.find(
      (i) => i.config.name === 'oncall_rosters_one_active_idx',
    )?.config;
    expect(index?.unique).toBe(true);
    expect(columnNames(index?.columns ?? [])).toEqual(['tenant_id']);
    expect(index?.where).toBeDefined();
  });

  it('members have a deterministic position and no PII columns', () => {
    const config = getTableConfig(oncallMembers);
    expect(config.columns.map((column) => column.name).toSorted()).toEqual(
      [
        'channel_refs',
        'created_at',
        'id',
        'level',
        'order_index',
        'roster_id',
        'tenant_id',
        'updated_at',
        'user_id',
      ].toSorted(),
    );
    const unique = config.uniqueConstraints.map((u) => [u.name, columnNames(u.columns)]);
    expect(unique).toContainEqual([
      'oncall_members_position_key',
      ['roster_id', 'level', 'order_index'],
    ]);
    expect(unique).toContainEqual(['oncall_members_seat_key', ['roster_id', 'level', 'user_id']]);
  });

  it('members and schedules reference their roster through the tenant-scoped key', () => {
    for (const table of [oncallMembers, oncallSchedules]) {
      const [foreignKey] = getTableConfig(table).foreignKeys;
      const reference = foreignKey?.reference();
      expect(columnNames(reference?.columns ?? [])).toEqual(['tenant_id', 'roster_id']);
      expect(columnNames(reference?.foreignColumns ?? [])).toEqual(['tenant_id', 'id']);
    }
  });
});

describe('oncall migration', () => {
  it('exists and is timestamp-named', () => {
    expect(migrationName).toMatch(/^\d{14}_oncall_rosters$/);
  });

  it('is forward-only', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('enables and forces RLS with the fail-closed predicate on every table', () => {
    for (const table of ['oncall_rosters', 'oncall_members', 'oncall_schedules']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "${table}" AS PERMISSIVE FOR ALL`,
      );
    }
    expect(migration).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(migration).toContain("WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('grants DML to bw_app only: not PUBLIC, no TRUNCATE, no BYPASSRLS', () => {
    expect(migration).toContain(
      'REVOKE ALL ON "oncall_rosters", "oncall_members", "oncall_schedules" FROM PUBLIC',
    );
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "oncall_rosters", "oncall_members", "oncall_schedules" TO bw_app',
    );
    expect(code).not.toMatch(/TRUNCATE|BYPASSRLS/i);
  });

  it('bounds levels, order and windows in the database', () => {
    expect(migration).toContain('"oncall_members"."level" BETWEEN 0 AND 2');
    expect(migration).toContain('"oncall_members"."order_index" BETWEEN 0 AND 1000');
    expect(migration).toContain('"oncall_schedules"."ends_at" > "oncall_schedules"."starts_at"');
    expect(migration).toContain(
      'UNIQUE INDEX "oncall_rosters_one_active_idx" ON "oncall_rosters" USING btree ("tenant_id") WHERE "oncall_rosters"."active"',
    );
  });

  it('keeps updated_at in step on every table', () => {
    for (const table of ['oncall_rosters', 'oncall_members', 'oncall_schedules']) {
      expect(migration).toContain(
        `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}`,
      );
    }
  });
});
