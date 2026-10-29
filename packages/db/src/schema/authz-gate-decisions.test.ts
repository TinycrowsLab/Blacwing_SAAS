import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { authzGateDecisions } from './authz-gate-decisions.js';

const migrationName = migrationNames().find((name) => name.endsWith('_authz_gate_decisions')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('authz_gate_decisions schema', () => {
  const config = getTableConfig(authzGateDecisions);

  it('keys one row by its UUIDv7 id', () => {
    expect(config.columns.find((c) => c.name === 'id')?.primary).toBe(true);
  });

  it('marks the identity, decision and audit columns NOT NULL', () => {
    for (const name of ['tenant_id', 'gate', 'subject_type', 'subject_id', 'decision', 'auto']) {
      expect(config.columns.find((c) => c.name === name)?.notNull, name).toBe(true);
    }
  });

  it('keeps at most one approved decision per tenant, gate and subject (partial unique index)', () => {
    const index = config.indexes.find(
      (i) => i.config.name === 'authz_gate_decisions_one_approved_idx',
    );
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'tenant_id',
      'gate',
      'subject_id',
    ]);
    expect(code).toContain(`WHERE "authz_gate_decisions"."decision" = 'approved'`);
  });

  it('is tenant-isolated by the canonical policy, forced on the owner, and append-only for bw_app', () => {
    expect(code).toContain('ENABLE ROW LEVEL SECURITY');
    expect(code).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(code).toContain('FORCE ROW LEVEL SECURITY');
    expect(code).toContain('GRANT SELECT, INSERT ON "authz_gate_decisions" TO bw_app');
    expect(code).toContain('REVOKE ALL ON "authz_gate_decisions" FROM bw_app');
    expect(code).not.toContain('UPDATE ON "authz_gate_decisions"');
  });
});
