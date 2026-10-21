import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ForbiddenError, TenantContextMissingError } from '@blackwing/errors';

import {
  RlsConfigError,
  rlsMigrationSql,
  rlsPolicyName,
  rlsPolicySql,
  toTenantIsolationError,
} from './rls.js';

describe('rlsPolicySql', () => {
  const sqlText = rlsPolicySql('widgets');

  it('enables and forces RLS and installs the canonical fail-closed policy', () => {
    expect(sqlText).toContain('ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;');
    expect(sqlText).toContain('ALTER TABLE "widgets" FORCE ROW LEVEL SECURITY;');
    expect(sqlText).toContain('CREATE POLICY "widgets_tenant_isolation" ON "widgets"');
    expect(sqlText).toContain('FOR ALL');
    expect(sqlText).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(sqlText).toContain("WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)");
  });

  it('never uses the missing-ok form of current_setting', () => {
    expect(sqlText).not.toMatch(/current_setting\([^)]*,/);
  });

  it('grants DML to bw_app only: no TRUNCATE, nothing to PUBLIC', () => {
    expect(sqlText).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "widgets" TO bw_app;');
    expect(sqlText).toContain('REVOKE ALL ON "widgets" FROM PUBLIC;');
    expect(sqlText).not.toMatch(/TRUNCATE/i);
    expect(sqlText).not.toMatch(/GRANT[^;]*TO PUBLIC/i);
  });

  it('fails at generation for a table without tenant_id', () => {
    expect(() => rlsPolicySql('widgets', { columns: ['id', 'name'] })).toThrow(RlsConfigError);
    expect(() => rlsPolicySql('widgets', { columns: ['id', 'name'] })).toThrow(/tenant_id/);
    const noTenant = pgTable('no_tenant', { id: uuid('id'), name: text('name') });
    expect(() => rlsPolicySql(noTenant)).toThrow(/no tenant_id column/);
  });

  it('accepts a drizzle table that has tenant_id', () => {
    const table = pgTable('with_tenant', { tenantId: uuid('tenant_id'), n: integer('n') });
    expect(rlsPolicySql(table)).toContain('"with_tenant_tenant_isolation"');
  });

  it('rejects unsafe or over-long table names (no SQL injection through the name)', () => {
    expect(() => rlsPolicySql('widgets"; DROP TABLE x; --')).toThrow(RlsConfigError);
    expect(() => rlsPolicySql('Widgets')).toThrow(RlsConfigError);
    expect(() => rlsPolicySql('a'.repeat(47))).toThrow(/too long/);
    expect(() => rlsPolicySql('a'.repeat(46))).not.toThrow();
  });

  it('names the policy <table>_tenant_isolation', () => {
    expect(rlsPolicyName('runs')).toBe('runs_tenant_isolation');
  });
});

describe('rlsMigrationSql', () => {
  it('joins tables with drizzle statement breakpoints, one statement per chunk', () => {
    const out = rlsMigrationSql(['a', 'b']);
    const chunks = out.split('--> statement-breakpoint\n');
    expect(chunks).toHaveLength(10);
    expect(chunks.every((chunk) => chunk.trim().endsWith(';'))).toBe(true);
  });
});

describe('toTenantIsolationError', () => {
  it('maps a missing or malformed tenant context to TenantContextMissingError', () => {
    const missing = Object.assign(
      new Error('unrecognized configuration parameter "app.tenant_id"'),
      {
        code: '42704',
      },
    );
    const invalid = Object.assign(new Error('invalid input syntax for type uuid: ""'), {
      code: '22P02',
    });
    expect(toTenantIsolationError(missing)).toBeInstanceOf(TenantContextMissingError);
    expect(toTenantIsolationError(invalid)).toBeInstanceOf(TenantContextMissingError);
  });

  it('maps a WITH CHECK violation to ForbiddenError without leaking row data', () => {
    const error = Object.assign(
      new Error('new row violates row-level security policy for table "widgets"'),
      { code: '42501' },
    );
    const mapped = toTenantIsolationError(error);
    expect(mapped).toBeInstanceOf(ForbiddenError);
    expect(mapped?.message).not.toContain('widgets');
  });

  it('ignores unrelated errors', () => {
    expect(toTenantIsolationError(new Error('boom'))).toBeUndefined();
    expect(toTenantIsolationError(null)).toBeUndefined();
  });
});
