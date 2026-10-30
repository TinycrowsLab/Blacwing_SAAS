import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { blackoutWindows, schedules } from './schedules.js';

const migrationName = migrationNames().find((name) => name.endsWith('_schedules')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);
const downMigration = readFileSync(`${MIGRATIONS_DIR}down/${migrationName}.sql`, 'utf8');

const columnNames = (columns: readonly unknown[]): unknown[] =>
  columns.map((c) => (c as { name?: string }).name);

describe('schedules schema', () => {
  const config = getTableConfig(schedules);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability and defaults', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      public_id: true,
      name: true,
      asset_ids: true,
      sa_id: true,
      mode: true,
      objective: false,
      cron_expr: true,
      timezone: true,
      overlap_policy: true,
      catch_up_policy: true,
      catch_up_window_minutes: true,
      budgets: false,
      enabled: true,
      temporal_schedule_id: false,
      last_fire_at: false,
      next_fire_at: false,
      created_by: true,
      created_at: true,
      updated_at: true,
    };
    expect(config.name).toBe('schedules');
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('overlap_policy')?.default).toBe('skip');
    expect(column('catch_up_policy')?.default).toBe('skip');
    expect(column('catch_up_window_minutes')?.default).toBe(60);
    expect(column('enabled')?.default).toBe(true);
  });

  it('keeps the public id unique and binds the SA through a tenant-scoped foreign key', () => {
    expect(config.uniqueConstraints.map((u) => u.name)).toContain('schedules_public_id_key');
    const fk = config.foreignKeys.find(
      (f) => f.getName() === 'schedules_standing_authorisation_fk',
    );
    expect(fk).toBeDefined();
    const reference = fk?.reference();
    expect(columnNames(reference?.columns ?? [])).toEqual(['tenant_id', 'sa_id']);
    expect(columnNames(reference?.foreignColumns ?? [])).toEqual(['tenant_id', 'id']);
  });

  it('indexes enabled state, next fire time and asset ids (GIN)', () => {
    const names = config.indexes.map((i) => i.config.name).toSorted();
    expect(names).toEqual(
      [
        'schedules_asset_ids_gin_idx',
        'schedules_next_fire_at_idx',
        'schedules_tenant_enabled_idx',
        'schedules_tenant_sa_idx',
      ].toSorted(),
    );
    const gin = config.indexes.find((i) => i.config.name === 'schedules_asset_ids_gin_idx');
    expect(gin?.config.method).toBe('gin');
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['schedules_tenant_isolation']);
  });
});

describe('blackout_windows schema', () => {
  const config = getTableConfig(blackoutWindows);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      scope: true,
      asset_ids: false,
      starts_at: true,
      ends_at: true,
      reason: false,
      created_by: true,
      created_at: true,
      updated_at: true,
    };
    expect(config.name).toBe('blackout_windows');
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
  });

  it('indexes the tenant window and asset ids (GIN)', () => {
    const names = config.indexes.map((i) => i.config.name).toSorted();
    expect(names).toEqual(
      ['blackout_windows_asset_ids_gin_idx', 'blackout_windows_tenant_window_idx'].toSorted(),
    );
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['blackout_windows_tenant_isolation']);
  });
});

describe('schedules migration', () => {
  it('exists and is timestamp-named', () => {
    expect(migrationName).toMatch(/^\d{14}_schedules$/);
  });

  it('is forward-only: the dev down file is separate and the up file never drops anything', () => {
    expect(code).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA|POLICY)\b/i);
    expect(downMigration).toMatch(/DROP TABLE "blackout_windows"/);
    expect(downMigration).toMatch(/DROP TABLE "schedules"/);
  });

  it('enables and forces RLS on both tables with the fail-closed predicate (no missing_ok)', () => {
    for (const table of ['schedules', 'blackout_windows']) {
      expect(code).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(code).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(code).toContain(
        `CREATE POLICY "${table}_tenant_isolation" ON "${table}" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)`,
      );
    }
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('grants bw_app DML only: never PUBLIC DML, no TRUNCATE, no BYPASSRLS', () => {
    expect(code).toContain('REVOKE ALL ON "schedules", "blackout_windows" FROM PUBLIC');
    expect(code).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON "schedules", "blackout_windows" TO bw_app',
    );
    expect(code).not.toMatch(/TRUNCATE|BYPASSRLS/i);
  });

  it('bounds enum values and windows in the database', () => {
    expect(migration).toContain(`"schedules"."mode" IN ('black', 'grey', 'white')`);
    expect(migration).toContain(
      `"schedules"."overlap_policy" IN ('skip', 'buffer_one', 'cancel_other', 'allow')`,
    );
    expect(migration).toContain(`"schedules"."catch_up_policy" IN ('skip', 'fire_once')`);
    expect(migration).toContain(`"blackout_windows"."scope" IN ('tenant', 'asset')`);
    expect(migration).toContain('"blackout_windows_window_check"');
    expect(migration).toContain('char_length("schedules"."name") BETWEEN 1 AND 200');
    expect(migration).not.toContain("'destructive'");
  });

  it('keeps updated_at in step with the database trigger', () => {
    expect(code).toContain(
      'CREATE TRIGGER schedules_set_updated_at BEFORE UPDATE ON schedules FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at()',
    );
    expect(code).toContain(
      'CREATE TRIGGER blackout_windows_set_updated_at BEFORE UPDATE ON blackout_windows FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at()',
    );
  });
});
