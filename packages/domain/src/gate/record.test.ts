import { describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  GATE_DECISION_AUDIT_ACTION,
  type GateDecisionAuditEvent,
  type GateDecisionPorts,
  type GateDecisionRow,
  recordGateDecision,
} from './record.js';
import { SodViolationError } from '../sod/index.js';

import type { GateDecisionInput } from '@blackwing/contracts';

const requester = newId();
const approver = newId();

function input(overrides: Partial<GateDecisionInput> = {}): GateDecisionInput {
  return {
    gate: 1,
    subjectType: 'test_plan',
    subjectId: newId(),
    decision: 'approved',
    requesterId: requester,
    actorId: approver,
    reason: null,
    decidedAt: null,
    timeoutAt: null,
    auto: false,
    ...overrides,
  };
}

function ports() {
  const rows: GateDecisionRow[] = [];
  const audits: GateDecisionAuditEvent[] = [];
  const decided: { gate: number; decision: string }[] = [];
  const warn = vi.fn();
  const deps: GateDecisionPorts = {
    insert: vi.fn((row: GateDecisionRow) => {
      rows.push(row);
      return Promise.resolve();
    }),
    audit: vi.fn((event: GateDecisionAuditEvent) => {
      audits.push(event);
      return Promise.resolve();
    }),
    metrics: {
      decided: (labels) => decided.push({ gate: labels.gate, decision: labels.decision }),
    },
    logger: { warn },
  };
  return { deps, rows, audits, decided, warn };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the decision to be refused');
}

describe('recordGateDecision: separation of duties (RBAC-011 primitives)', () => {
  it.each([1, 2] as const)(
    'refuses a gate %i self-approval with SodViolationError SOD_VIOLATION',
    async (gate) => {
      const p = ports();
      const error = await refusal(
        recordGateDecision(p.deps, input({ gate, actorId: requester, requesterId: requester })),
      );
      expect(error).toBeInstanceOf(SodViolationError);
      expect(error).toMatchObject({
        code: 'SOD_VIOLATION',
        reason: 'requester_equals_approver',
        context: `gate${gate}.approve`,
      });
      expect(p.deps.insert).not.toHaveBeenCalled();
      expect(p.deps.audit).not.toHaveBeenCalled();
      expect(p.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'requester_equals_approver' }),
        'sod.violation',
      );
    },
  );

  it('refuses a missing requester on a gate 1 approval (null_actor, fail closed)', async () => {
    const p = ports();
    const error = await refusal(recordGateDecision(p.deps, input({ requesterId: null })));
    expect(error).toMatchObject({ code: 'SOD_VIOLATION', reason: 'null_actor' });
    expect(p.deps.insert).not.toHaveBeenCalled();
  });

  it('refuses a missing actor on a gate 2 approval (null_actor, fail closed)', async () => {
    const p = ports();
    const error = await refusal(recordGateDecision(p.deps, input({ gate: 2, actorId: null })));
    expect(error).toMatchObject({ code: 'SOD_VIOLATION', reason: 'null_actor' });
    expect(p.deps.insert).not.toHaveBeenCalled();
  });

  it('allows distinct requester and approver on gates 1 and 2', async () => {
    for (const gate of [1, 2] as const) {
      const p = ports();
      const row = await recordGateDecision(p.deps, input({ gate }));
      expect(row.actorId).toBe(approver);
      expect(p.rows).toHaveLength(1);
    }
  });

  it('does not apply SoD to gate 3 (findings release, §8.4)', async () => {
    const p = ports();
    const row = await recordGateDecision(
      p.deps,
      input({ gate: 3, subjectType: 'run', actorId: requester, requesterId: requester }),
    );
    expect(row).toMatchObject({ gate: 3, actorId: requester, decision: 'approved' });
    expect(p.rows).toHaveLength(1);
  });

  it('still requires an actor for a manual non-approval decision', async () => {
    const p = ports();
    await expect(
      recordGateDecision(p.deps, input({ decision: 'rejected', actorId: null })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      recordGateDecision(p.deps, input({ gate: 3, subjectType: 'run', actorId: null })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(p.deps.insert).not.toHaveBeenCalled();
  });
});

describe('recordGateDecision: automatic decisions', () => {
  it('writes an auto-approval with no actor, skipping SoD, and audits it', async () => {
    const p = ports();
    const row = await recordGateDecision(
      p.deps,
      input({ decision: 'auto_approved', auto: true, actorId: null, requesterId: null }),
    );
    expect(row).toMatchObject({ decision: 'auto_approved', actorId: null, auto: true });
    expect(p.audits).toEqual([
      expect.objectContaining({
        action: GATE_DECISION_AUDIT_ACTION,
        decisionId: row.id,
        actorId: null,
        auto: true,
      }),
    ]);
  });

  it('refuses an automatic decision that names an actor', async () => {
    const p = ports();
    await expect(
      recordGateDecision(
        p.deps,
        input({ decision: 'auto_approved', auto: true, actorId: approver }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(p.deps.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['approved with auto true', { decision: 'approved' as const, auto: true, actorId: null }],
    ['auto_approved with auto false', { decision: 'auto_approved' as const, auto: false }],
  ])('refuses %s', async (_label, overrides) => {
    const p = ports();
    await expect(recordGateDecision(p.deps, input(overrides))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(p.deps.insert).not.toHaveBeenCalled();
  });
});

describe('recordGateDecision: write, audit and metrics', () => {
  it('writes one row, emits authz.gate.decision and counts the decision', async () => {
    const p = ports();
    const subjectId = newId();
    const row = await recordGateDecision(p.deps, input({ subjectId, reason: 'in scope' }));
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row).toMatchObject({ gate: 1, subjectId, decision: 'approved', reason: 'in scope' });
    expect(p.audits).toEqual([
      {
        action: 'authz.gate.decision',
        decisionId: row.id,
        gate: 1,
        subjectType: 'test_plan',
        subjectId,
        decision: 'approved',
        actorId: approver,
        auto: false,
      },
    ]);
    expect(p.decided).toEqual([{ gate: 1, decision: 'approved' }]);
  });

  it('does not write the row when the audit append fails (decision rolls back)', async () => {
    const p = ports();
    const failing: GateDecisionPorts = {
      ...p.deps,
      audit: vi.fn(() => Promise.reject(new Error('ledger unavailable'))),
    };
    await expect(recordGateDecision(failing, input())).rejects.toThrow('ledger unavailable');
    expect(p.decided).toEqual([]);
  });

  it('propagates a storage failure without auditing or counting', async () => {
    const p = ports();
    const failing: GateDecisionPorts = {
      ...p.deps,
      insert: vi.fn(() => Promise.reject(new Error('unique violation'))),
    };
    await expect(recordGateDecision(failing, input())).rejects.toThrow('unique violation');
    expect(p.audits).toEqual([]);
    expect(p.decided).toEqual([]);
  });
});

describe('recordGateDecision: input validation (fails closed)', () => {
  it.each([
    ['gate 4', { gate: 4 }],
    ['unknown subject type', { subjectType: 'report' }],
    ['non-uuid subject id', { subjectId: 'not-a-uuid' }],
    ['unknown decision', { decision: 'maybe' }],
    ['blank reason', { reason: '   ' }],
    ['non-uuid actor', { actorId: 'someone' }],
  ])('refuses %s without writing', async (_label, overrides) => {
    const p = ports();
    const bad = { ...input(), ...overrides } as unknown as GateDecisionInput;
    await expect(recordGateDecision(p.deps, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(p.deps.insert).not.toHaveBeenCalled();
  });

  it('refuses unknown extra fields (strict contract)', async () => {
    const p = ports();
    const bad = { ...input(), tenantId: newId() } as unknown as GateDecisionInput;
    await expect(recordGateDecision(p.deps, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(p.deps.insert).not.toHaveBeenCalled();
  });
});
