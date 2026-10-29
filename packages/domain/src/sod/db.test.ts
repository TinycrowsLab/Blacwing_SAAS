import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { sodCheckConstraint, sodTrigger, SOD_RAISE_PREFIX, SOD_SQLSTATE } from './db.js';

const spec = { table: 'gate_decisions', requesterCol: 'requester_id', approverCol: 'approver_id' };

describe('sodCheckConstraint', () => {
  it('emits a named CHECK that forbids requester = approver', () => {
    expect(sodCheckConstraint(spec)).toBe(
      'ALTER TABLE "gate_decisions" ADD CONSTRAINT "sod_gate_decisions_requester_id_approver_id_ck" CHECK ("requester_id" <> "approver_id");',
    );
  });

  it('refuses identifiers that are not plain lowercase SQL names', () => {
    const bad = [
      'Gate',
      '1gate',
      'gate; DROP TABLE users',
      'gate"x',
      'gate-x',
      'gate.x',
      '',
      'a'.repeat(64),
    ];
    for (const table of bad) {
      expect(() => sodCheckConstraint({ ...spec, table })).toThrow(ValidationError);
    }
    expect(() => sodCheckConstraint({ ...spec, approverCol: 'x"; DROP TABLE t; --' })).toThrow(
      ValidationError,
    );
    expect(() => sodCheckConstraint({ ...spec, requesterCol: 'Requester' })).toThrow(
      ValidationError,
    );
  });

  it('refuses the same column for requester and approver', () => {
    expect(() => sodCheckConstraint({ ...spec, approverCol: 'requester_id' })).toThrow(
      ValidationError,
    );
  });

  it('refuses a generated name that would exceed the 63 character PostgreSQL limit', () => {
    const table = 'a'.repeat(30);
    const requesterCol = 'b'.repeat(15);
    const approverCol = 'c'.repeat(15);
    expect(() => sodCheckConstraint({ table, requesterCol, approverCol })).toThrow(/63 characters/);
  });
});

describe('sodTrigger', () => {
  const sql = sodTrigger(spec);

  it('is a BEFORE INSERT OR UPDATE row trigger on the table', () => {
    expect(sql).toContain(
      'CREATE TRIGGER "sod_gate_decisions_requester_id_approver_id_trg" BEFORE INSERT OR UPDATE ON "gate_decisions" FOR EACH ROW EXECUTE FUNCTION "sod_gate_decisions_requester_id_approver_id_fn"();',
    );
  });

  it('raises the custom SQLSTATE with the sod_violation prefix', () => {
    expect(SOD_SQLSTATE).toBe('SOD01');
    expect(SOD_RAISE_PREFIX).toBe('sod_violation');
    expect(sql.match(new RegExp(`ERRCODE = '${SOD_SQLSTATE}'`, 'g'))).toHaveLength(2);
    expect(sql).toContain(`RAISE EXCEPTION '${SOD_RAISE_PREFIX}: requester equals approver'`);
  });

  it('rejects a NULL requester and only compares when the approver is set (NULL = undecided passes)', () => {
    expect(sql).toContain('IF NEW."requester_id" IS NULL THEN');
    expect(sql).toContain(
      'IF NEW."approver_id" IS NOT NULL AND NEW."requester_id" = NEW."approver_id" THEN',
    );
  });

  it('replaces the function and drops the old trigger so it is safe to re-run', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION');
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS "sod_gate_decisions_requester_id_approver_id_trg" ON "gate_decisions";',
    );
  });

  it('validates identifiers before generating it', () => {
    expect(() => sodTrigger({ ...spec, table: 'x; DROP TABLE y' })).toThrow(ValidationError);
  });
});
