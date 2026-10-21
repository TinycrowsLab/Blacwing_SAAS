import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_GENESIS_PREV_HASH,
  auditOutcomeSchema,
  auditSeveritySchema,
} from '@blackwing/contracts';

import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { AUDIT_GENESIS_PREV_HASH_HEX, auditEvents } from './audit.js';

const migration = (): string => {
  const name = migrationNames().find((tag) => tag.endsWith('_audit_events'));
  if (!name) throw new Error('audit_events migration not found');
  return readFileSync(`${MIGRATIONS_DIR}${name}.sql`, 'utf8');
};

describe('audit_events schema', () => {
  const config = getTableConfig(auditEvents);

  it('has the AuditEvent columns plus the chain columns', () => {
    expect(config.columns.map((column) => column.name)).toEqual([
      'id',
      'tenant_id',
      'seq',
      'occurred_at',
      'action',
      'severity',
      'actor',
      'target',
      'outcome',
      'reason',
      'metadata',
      'metadata_ref',
      'trace_id',
      'run_id',
      'ip',
      'user_agent',
      'prev_hash',
      'hash',
      'created_at',
    ]);
    const column = (name: string) => config.columns.find((c) => c.name === name);
    expect(column('tenant_id')?.notNull).toBe(true);
    expect(column('seq')?.notNull).toBe(true);
    expect(column('hash')?.notNull).toBe(true);
    expect(column('prev_hash')?.notNull).toBe(false);
    expect(column('id')?.primary).toBe(true);
  });

  it('has the unique chain position and the required indexes', () => {
    expect(config.uniqueConstraints.map((u) => [u.name, u.columns.map((c) => c.name)])).toEqual([
      ['audit_events_tenant_seq_key', ['tenant_id', 'seq']],
    ]);
    const indexes = config.indexes.map((i) => [
      i.config.name,
      i.config.columns.map((c) => ('name' in c ? c.name : '')),
    ]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        ['audit_events_tenant_occurred_at_idx', ['tenant_id', 'occurred_at']],
        ['audit_events_tenant_action_idx', ['tenant_id', 'action']],
        ['audit_events_run_id_idx', ['run_id']],
      ]),
    );
  });

  it('carries the tenant isolation policy', () => {
    expect(config.policies.map((policy) => policy.name)).toEqual(['audit_events_tenant_isolation']);
  });

  it('keeps the severity and outcome checks in step with the contract', () => {
    const sql = migration();
    const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
    expect(sql).toContain(`IN (${list(auditSeveritySchema.options)})`);
    expect(sql).toContain(`IN (${list(auditOutcomeSchema.options)})`);
  });

  it('keeps the genesis constant in step with the AUDIT-001 contract', () => {
    expect(AUDIT_GENESIS_PREV_HASH_HEX).toBe(AUDIT_GENESIS_PREV_HASH);
  });
});

describe('audit_events migration', () => {
  it('forces RLS and grants the app role SELECT and INSERT only', () => {
    const sql = migration();
    expect(sql).toContain('ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(sql).toContain("WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM bw_app');
    expect(sql).toContain('GRANT SELECT, INSERT ON "audit_events" TO bw_app');
    expect(sql).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE)\b[^;]*ON "audit_events"/);
  });

  it('blocks UPDATE, DELETE and TRUNCATE with one statement-level trigger', () => {
    expect(migration()).toContain(
      'CREATE TRIGGER audit_events_no_mutate BEFORE UPDATE OR DELETE OR TRUNCATE ON "audit_events" FOR EACH STATEMENT',
    );
  });

  it('serialises per tenant with an advisory lock keyed by the tenant id', () => {
    const sql = migration();
    expect(sql.match(/pg_advisory_xact_lock\(hashtext\(/g)).toHaveLength(2);
    expect(sql).toContain('CREATE TRIGGER audit_events_chain_check BEFORE INSERT');
  });

  it('is forward-only', () => {
    expect(migration()).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });
});
