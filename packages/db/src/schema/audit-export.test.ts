import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import {
  AUDIT_EXPORT_KINDS,
  AUDIT_EXPORT_STATUSES,
  auditExportSubscriptions,
} from './audit-export.js';

const migrationName =
  migrationNames().find((name) => name.endsWith('_audit_export_subscriptions')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);

describe('audit export subscription schema', () => {
  const config = getTableConfig(auditExportSubscriptions);

  it('is tenant scoped with the canonical policy and carries the issue columns', () => {
    const names = config.columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'tenant_id',
        'kind',
        'config',
        'secret_ref',
        'cursor_seq',
        'status',
        'filters',
        'created_at',
        'updated_at',
      ]),
    );
    expect(config.policies.map((policy) => policy.name)).toEqual([
      'audit_export_subscriptions_tenant_isolation',
    ]);
  });

  it('defines the four connector kinds and the three statuses', () => {
    expect(AUDIT_EXPORT_KINDS).toEqual(['syslog_tls', 'splunk_hec', 'webhook_hmac', 's3']);
    expect(AUDIT_EXPORT_STATUSES).toEqual(['active', 'paused', 'error']);
  });

  it('starts a subscription at cursor 0 and active', () => {
    const cursor = config.columns.find((column) => column.name === 'cursor_seq');
    const status = config.columns.find((column) => column.name === 'status');
    expect(cursor?.default).toBe(0);
    expect(status?.default).toBe('active');
  });

  it('forces RLS and grants no TRUNCATE to the app role', () => {
    expect(migration).toContain(
      'ALTER TABLE "audit_export_subscriptions" FORCE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'CREATE POLICY "audit_export_subscriptions_tenant_isolation" ON "audit_export_subscriptions"',
    );
    expect(code).toContain('REVOKE TRUNCATE ON "audit_export_subscriptions" FROM bw_app');
  });

  it('forbids a rewind of the cursor in the database', () => {
    expect(code).toContain('CREATE FUNCTION bw_audit_export_cursor_guard()');
    expect(code).toContain('IF NEW.cursor_seq < OLD.cursor_seq THEN');
    expect(code).toContain('BEFORE UPDATE OF "cursor_seq" ON "audit_export_subscriptions"');
  });
});
