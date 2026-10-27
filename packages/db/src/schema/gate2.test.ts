import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { GATE2_STATES } from '@blackwing/contracts';

import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import {
  GATE2_IDEMPOTENCY_CONSTRAINT,
  GATE_DECISIONS_GATE2_SUBJECT_INDEX,
  gate2Exceptions,
  gateDecisions,
} from './gate2.js';

const migrationName = migrationNames().find((name) => name.endsWith('_gate2_exceptions')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');

describe('gate2_exceptions schema', () => {
  const config = getTableConfig(gate2Exceptions);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      run_id: true,
      session_id: true,
      subtask_id: false,
      test_case_id: false,
      tool_name: true,
      proposed_action: true,
      envelope_reason: true,
      intrusiveness: true,
      batch: true,
      state: true,
      state_version: true,
      requester_id: false,
      plan_approver_id: false,
      decided_by: false,
      decided_at: false,
      timeout_at: true,
      idempotency_key: true,
      created_at: true,
      updated_at: true,
    };
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('id')?.primary).toBe(true);
    expect(column('batch')?.default).toBe(false);
    expect(column('state')?.default).toBe('pending');
    expect(column('state_version')?.default).toBe(0);
  });

  it('is unique per (tenant_id, idempotency_key)', () => {
    const unique = config.uniqueConstraints.find((u) => u.name === GATE2_IDEMPOTENCY_CONSTRAINT);
    expect(unique?.columns.map((c) => c.name)).toEqual(['tenant_id', 'idempotency_key']);
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['gate2_exceptions_tenant_isolation']);
  });

  it('has exactly the five states of the issue', () => {
    expect([...GATE2_STATES]).toEqual([
      'pending',
      'approved_once',
      'denied',
      'timed_out',
      'superseded',
    ]);
    expect(migration).toContain(
      "CHECK (\"gate2_exceptions\".\"state\" IN ('pending', 'approved_once', 'denied', 'timed_out', 'superseded'))",
    );
  });
});

describe('gate_decisions schema', () => {
  const config = getTableConfig(gateDecisions);

  it('records gate, subject, decision, actor, reason, decided_at, timeout_at and auto (§7)', () => {
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(
      [
        'id',
        'tenant_id',
        'gate',
        'subject_type',
        'subject_id',
        'run_id',
        'decision',
        'actor_id',
        'reason',
        'decided_at',
        'timeout_at',
        'auto',
        'created_at',
      ].toSorted(),
    );
  });

  it('allows one Gate 2 decision per exception', () => {
    const index = config.indexes.find((i) => i.config.name === GATE_DECISIONS_GATE2_SUBJECT_INDEX);
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });

  it('carries the canonical tenant policy', () => {
    expect(config.policies.map((p) => p.name)).toEqual(['gate_decisions_tenant_isolation']);
  });
});

describe('gate2_exceptions migration', () => {
  it('is timestamp-named and forward-only', () => {
    expect(migrationName).toMatch(/^\d{14}_gate2_exceptions$/);
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('enables and forces RLS on both tables with the fail-closed predicate (no missing_ok)', () => {
    for (const table of ['gate2_exceptions', 'gate_decisions']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
    }
    expect(migration).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('keeps the decision ledger append-only and exceptions undeletable for the app role', () => {
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "gate_decisions" FROM bw_app');
    expect(migration).toContain('GRANT SELECT, INSERT ON "gate_decisions" TO bw_app');
    expect(migration).toContain('REVOKE DELETE, TRUNCATE ON "gate2_exceptions" FROM bw_app');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE ON "gate2_exceptions" TO bw_app');
    expect(migration).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE ON "gate_decisions"');
  });

  it('enforces SoD, the destructive block and the approval deadline as CHECKs and triggers', () => {
    expect(migration).toContain('"gate2_exceptions_sod_check"');
    expect(migration).toContain('"gate2_exceptions_no_destructive_approval_check"');
    expect(migration).toContain('"gate2_exceptions_approved_in_time_check"');
    expect(migration).toContain('CREATE TRIGGER gate2_exceptions_guard BEFORE INSERT OR UPDATE');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER gate2_exceptions_decision_check');
  });
});
