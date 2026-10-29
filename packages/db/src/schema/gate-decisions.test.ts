import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { gateDecisions } from './gate-decisions.js';

const migrationName = migrationNames().find((name) => name.endsWith('_gate_decisions')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('gate_decisions schema', () => {
  const config = getTableConfig(gateDecisions);

  it('keys one row by decision id and dedupes opens per tenant', () => {
    expect(config.primaryKeys).toHaveLength(0);
    expect(config.columns.find((c) => c.name === 'decision_id')?.primary).toBe(true);
    expect(config.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual([
      ['tenant_id', 'dedupe_key'],
    ]);
  });

  it('marks the identity, request and deadline columns NOT NULL', () => {
    for (const name of ['tenant_id', 'run_id', 'gate', 'kind', 'dedupe_key', 'summary', 'status']) {
      expect(config.columns.find((c) => c.name === name)?.notNull, name).toBe(true);
    }
    expect(config.columns.find((c) => c.name === 'requested_at')?.notNull).toBe(true);
    expect(config.columns.find((c) => c.name === 'timeout_at')?.notNull).toBe(true);
  });

  it('is tenant-isolated by the canonical policy, with FORCE RLS and no DELETE grant in the migration', () => {
    expect(code).toContain('ENABLE ROW LEVEL SECURITY');
    expect(code).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(code).toContain('FORCE ROW LEVEL SECURITY');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "gate_decisions" TO bw_app');
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "gate_decisions" FROM bw_app');
  });
});
