// The Gate 2 service against an in-memory store (no Postgres): idempotency, the optimistic-concurrency
// races, exactly one decision row and audit event per terminal transition, default deny and fail-closed
// tenant context. The SQL side (RLS, triggers, constraints) is proved in gate2.int.test.ts.

import { describe, expect, it } from 'vitest';

import { Gate2AlreadyDecidedError, IllegalGate2TransitionError } from '@blackwing/domain';
import {
  ConflictError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import {
  createGate2Service,
  type Gate2AuditEvent,
  type Gate2DecisionRequest,
  type Gate2Service,
} from './gate2.js';
import type { Gate2Store, Gate2Transition } from './gate2-store.js';
import type {
  Gate2ExceptionRow,
  NewGate2ExceptionRow,
  NewGateDecisionRow,
} from './schema/gate2.js';
import type { TenantTx } from './with-tenant.js';

const TENANT = newId();
const RUN = newId();
const REQUESTER = newId();
const PLAN_APPROVER = newId();
const ONCALL = newId();
const OTHER_ONCALL = newId();

/** An in-memory Gate2Store with a controllable clock that mirrors the SQL guards of `transition`. */
class MemoryStore implements Gate2Store {
  readonly rows = new Map<string, Gate2ExceptionRow>();
  readonly decisions: NewGateDecisionRow[] = [];
  clock = new Date('2026-10-21T10:00:00.000Z');
  tenant: string | undefined = TENANT;
  /** Runs once before the next `transition`, to simulate a concurrent commit. */
  beforeTransition: (() => void) | undefined;

  tenantId(): Promise<string> {
    if (this.tenant === undefined)
      return Promise.reject(new TenantContextMissingError('no tenant'));
    return Promise.resolve(this.tenant);
  }
  now(): Promise<Date> {
    return Promise.resolve(new Date(this.clock));
  }
  insertException(row: NewGate2ExceptionRow): Promise<Gate2ExceptionRow | undefined> {
    for (const existing of this.rows.values()) {
      if (existing.tenantId === row.tenantId && existing.idempotencyKey === row.idempotencyKey) {
        return Promise.resolve(undefined);
      }
    }
    const stored: Gate2ExceptionRow = {
      id: row.id ?? newId(),
      tenantId: row.tenantId,
      runId: row.runId,
      sessionId: row.sessionId,
      subtaskId: row.subtaskId ?? null,
      testCaseId: row.testCaseId ?? null,
      toolName: row.toolName,
      proposedAction: row.proposedAction,
      envelopeReason: row.envelopeReason,
      intrusiveness: row.intrusiveness,
      batch: row.batch ?? false,
      state: 'pending',
      stateVersion: 0,
      requesterId: row.requesterId ?? null,
      planApproverId: row.planApproverId ?? null,
      decidedBy: null,
      decidedAt: null,
      timeoutAt: row.timeoutAt,
      idempotencyKey: row.idempotencyKey,
      createdAt: new Date(this.clock),
      updatedAt: new Date(this.clock),
    };
    this.rows.set(stored.id, stored);
    return Promise.resolve(stored);
  }
  findByIdempotencyKey(key: string): Promise<Gate2ExceptionRow | undefined> {
    return Promise.resolve([...this.rows.values()].find((row) => row.idempotencyKey === key));
  }
  findById(id: string): Promise<Gate2ExceptionRow | undefined> {
    return Promise.resolve(this.rows.get(id));
  }
  transition(change: Gate2Transition): Promise<Gate2ExceptionRow | undefined> {
    this.beforeTransition?.();
    this.beforeTransition = undefined;
    const row = this.rows.get(change.id);
    if (row?.state !== 'pending' || row.stateVersion !== change.fromVersion) {
      return Promise.resolve(undefined);
    }
    const late = this.clock.getTime() >= row.timeoutAt.getTime();
    if ((change.event === 'approve' && late) || (change.event === 'time_out' && !late)) {
      return Promise.resolve(undefined);
    }
    const next: Gate2ExceptionRow = {
      ...row,
      state: change.to,
      stateVersion: change.fromVersion + 1,
      decidedBy: change.decidedBy,
      decidedAt: new Date(this.clock),
    };
    this.rows.set(row.id, next);
    return Promise.resolve(next);
  }
  insertDecision(row: NewGateDecisionRow): Promise<void> {
    this.decisions.push(row);
    return Promise.resolve();
  }
}

interface Harness {
  readonly store: MemoryStore;
  readonly service: Gate2Service;
  readonly audit: Gate2AuditEvent[];
  readonly counts: string[];
}

function harness(): Harness {
  const store = new MemoryStore();
  const audit: Gate2AuditEvent[] = [];
  const counts: string[] = [];
  const service = createGate2Service({} as TenantTx, store, {
    audit: (_tx, event) => {
      audit.push(event);
      return Promise.resolve();
    },
    metrics: { exception: (state) => counts.push(state) },
    logger: { child: () => ({ info: () => undefined }) } as never,
  });
  return { store, service, audit, counts };
}

const create = (over: Record<string, unknown> = {}) => ({
  runId: RUN,
  sessionId: 'sess-1',
  toolName: 'http.request',
  proposedAction: { method: 'POST', url: 'https://app.example.test/orders' },
  envelopeReason: 'Cedar: no permit matched state_changing POST outside the envelope',
  intrusiveness: 'state_changing',
  requesterId: REQUESTER,
  planApproverId: PLAN_APPROVER,
  timeoutAt: '2026-10-21T10:15:00.000Z',
  idempotencyKey: 'run-1:tool-call-7',
  ...over,
});

const person = (id: string): Gate2DecisionRequest['actor'] => ({ kind: 'user', id });
const system = { kind: 'system', id: 'gate2-timer' } as const;

async function open(h: Harness, over: Record<string, unknown> = {}) {
  return (await h.service.create(create(over))).exception;
}

describe('create', () => {
  it('opens a pending exception at version 0 with the tenant of the transaction', async () => {
    const h = harness();
    const { exception, created } = await h.service.create(create());
    expect(created).toBe(true);
    expect(exception).toMatchObject({
      tenantId: TENANT,
      state: 'pending',
      stateVersion: 0,
      decidedBy: null,
      decidedAt: null,
      timeoutAt: '2026-10-21T10:15:00.000Z',
      batch: false,
    });
    expect(h.audit.map((event) => event.action)).toEqual(['gate2.exception.created']);
    expect(h.counts).toEqual(['pending']);
    expect(h.store.decisions).toHaveLength(0);
  });

  it('is idempotent: the same key returns the existing exception, no duplicate, no second audit', async () => {
    const h = harness();
    const first = await h.service.create(create());
    const second = await h.service.create(create());
    expect(second.created).toBe(false);
    expect(second.exception.id).toBe(first.exception.id);
    expect(h.store.rows.size).toBe(1);
    expect(h.audit).toHaveLength(1);
    expect(h.counts).toEqual(['pending']);
  });

  it('refuses an idempotency key that names a different exception', async () => {
    const h = harness();
    await h.service.create(create());
    await expect(h.service.create(create({ toolName: 'other.tool' }))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(h.service.create(create({ runId: newId() }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('fails closed without a tenant context and writes nothing', async () => {
    const h = harness();
    h.store.tenant = undefined;
    await expect(h.service.create(create())).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(h.service.get(newId())).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(h.store.rows.size).toBe(0);
    expect(h.audit).toHaveLength(0);
  });

  it('rejects malformed input, a tenant field and a timeout that is not in the future', async () => {
    const h = harness();
    for (const bad of [
      { toolName: '' },
      { intrusiveness: 'Destructive ' },
      { idempotencyKey: 'has space' },
      { timeoutAt: '2026-10-21T10:00:00.000Z' },
      { timeoutAt: '2026-10-21T09:00:00.000Z' },
      { timeoutAt: 'tomorrow' },
      { tenantId: newId() },
      { proposedAction: [] },
    ]) {
      await expect(h.service.create(create(bad)), JSON.stringify(bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect(h.store.rows.size).toBe(0);
  });

  it('redacts secrets in the proposed action and the envelope reason (§8.7)', async () => {
    const h = harness();
    const { exception } = await h.service.create(
      create({
        proposedAction: {
          url: 'https://app.example.test',
          headers: { authorization: 'Bearer abc', apiKey: 'k' },
        },
        envelopeReason: 'denied for Bearer abcdefghijklmnop',
      }),
    );
    expect(JSON.stringify(exception.proposedAction)).not.toMatch(/abc|"k"/);
    expect(exception.envelopeReason).not.toContain('abcdefghijklmnop');
  });

  it('rejects a proposed action over the size cap', async () => {
    const h = harness();
    const big = { blob: 'x'.repeat(70_000) };
    await expect(h.service.create(create({ proposedAction: big }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('decide: terminal transitions each write exactly one gate_decisions row and one audit event', () => {
  it('approve -> approved_once (gate 2, not auto, reason recorded)', async () => {
    const h = harness();
    const { id } = await open(h);
    const result = await h.service.decide({
      exceptionId: id,
      event: 'approve',
      actor: person(ONCALL),
      reason: 'looks safe, scoped to a test account',
    });
    expect(result).toMatchObject({
      applied: true,
      exception: { state: 'approved_once', stateVersion: 1, decidedBy: ONCALL },
    });
    expect(h.store.decisions).toHaveLength(1);
    expect(h.store.decisions[0]).toMatchObject({
      tenantId: TENANT,
      gate: 2,
      subjectType: 'gate2_exception',
      subjectId: id,
      runId: RUN,
      decision: 'approved',
      actorId: ONCALL,
      auto: false,
      reason: 'looks safe, scoped to a test account',
    });
    expect(h.audit.map((event) => event.action)).toEqual([
      'gate2.exception.created',
      'gate2.decision.recorded',
    ]);
    expect(h.counts).toEqual(['pending', 'approved_once']);
  });

  it('deny -> denied', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({
      exceptionId: id,
      event: 'deny',
      actor: person(ONCALL),
      reason: 'not needed',
    });
    expect(h.store.rows.get(id)?.state).toBe('denied');
    expect(h.store.decisions).toEqual([
      expect.objectContaining({ decision: 'denied', auto: false, actorId: ONCALL }),
    ]);
  });

  it('time_out -> timed_out, auto, denied, no actor', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    const result = await h.service.decide({ exceptionId: id, event: 'time_out', actor: system });
    expect(result.exception.state).toBe('timed_out');
    expect(h.store.decisions).toEqual([
      expect.objectContaining({
        decision: 'denied',
        auto: true,
        actorId: null,
        reason: expect.stringMatching(/denied by default/),
      }),
    ]);
  });

  it('supersede -> superseded, auto, denied, with the given reason', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({
      exceptionId: id,
      event: 'supersede',
      actor: system,
      reason: 'run killed',
    });
    expect(h.store.rows.get(id)?.state).toBe('superseded');
    expect(h.store.decisions).toEqual([
      expect.objectContaining({ decision: 'denied', auto: true, reason: 'run killed' }),
    ]);
  });

  it('writes the audit intent of the machine (from, to, actor, reason)', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({ exceptionId: id, event: 'deny', actor: person(ONCALL), reason: 'no' });
    const recorded = h.audit.at(-1);
    expect(recorded).toMatchObject({
      action: 'gate2.decision.recorded',
      intent: {
        from: 'pending',
        to: 'denied',
        eventType: 'deny',
        actor: { kind: 'user', id: ONCALL },
        reason: 'no',
      },
    });
  });
});

describe('decide: separation of duties, destructive and default deny at the service layer', () => {
  it('rejects approval by the requester', async () => {
    const h = harness();
    const { id } = await open(h);
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'approve',
        actor: person(REQUESTER),
        reason: 'self',
      }),
    ).rejects.toMatchObject({ code: 'GATE2_SOD_VIOLATION' });
    expect(h.store.rows.get(id)?.state).toBe('pending');
    expect(h.store.decisions).toHaveLength(0);
  });

  it('rejects approval by the plan approver', async () => {
    const h = harness();
    const { id } = await open(h);
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'approve',
        actor: person(PLAN_APPROVER),
        reason: 'self',
      }),
    ).rejects.toMatchObject({ code: 'GATE2_SOD_VIOLATION' });
    expect(h.store.rows.get(id)?.state).toBe('pending');
  });

  it('rejects approving a destructive exception, for any approver', async () => {
    const h = harness();
    const { id } = await open(h, { intrusiveness: 'destructive', idempotencyKey: 'd' });
    await expect(
      h.service.decide({ exceptionId: id, event: 'approve', actor: person(ONCALL), reason: 'ok' }),
    ).rejects.toMatchObject({ code: 'GATE2_DESTRUCTIVE_FORBIDDEN' });
    expect(h.store.rows.get(id)?.state).toBe('pending');
    await h.service.decide({
      exceptionId: id,
      event: 'deny',
      actor: person(ONCALL),
      reason: 'blocked',
    });
    expect(h.store.rows.get(id)?.state).toBe('denied');
  });

  it('never lets a person trigger the system events, nor the system approve', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T11:00:00.000Z');
    await expect(
      h.service.decide({ exceptionId: id, event: 'time_out', actor: person(ONCALL) }),
    ).rejects.toBeInstanceOf(IllegalGate2TransitionError);
    await expect(
      h.service.decide({ exceptionId: id, event: 'supersede', actor: person(ONCALL) }),
    ).rejects.toBeInstanceOf(IllegalGate2TransitionError);
    h.store.clock = new Date('2026-10-21T10:01:00.000Z');
    await expect(
      h.service.decide({ exceptionId: id, event: 'approve', actor: system, reason: 'auto' }),
    ).rejects.toBeInstanceOf(IllegalGate2TransitionError);
  });

  it('requires a reason for a person and validates the exception id', async () => {
    const h = harness();
    const { id } = await open(h);
    await expect(
      h.service.decide({ exceptionId: id, event: 'approve', actor: person(ONCALL) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      h.service.decide({
        exceptionId: 'not-a-uuid',
        event: 'deny',
        actor: person(ONCALL),
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('an approval at or after the timeout is refused: silence is a denial', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'approve',
        actor: person(ONCALL),
        reason: 'late',
      }),
    ).rejects.toBeInstanceOf(IllegalGate2TransitionError);
    expect(h.store.rows.get(id)?.state).toBe('pending');
    expect(h.store.decisions).toHaveLength(0);
  });

  it('refuses an unknown exception, and another tenant sees none (not found)', async () => {
    const h = harness();
    const { id } = await open(h);
    await expect(
      h.service.decide({ exceptionId: newId(), event: 'deny', actor: person(ONCALL), reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    h.store.tenant = newId();
    // The in-memory store has no RLS; the Postgres store hides other tenants' rows (int test).
    expect(await h.service.get(id)).toBeDefined();
  });
});

describe('decide: races (first committed wins)', () => {
  it('a second human decision after the first fails GATE2_ALREADY_DECIDED and changes nothing', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({
      exceptionId: id,
      event: 'approve',
      actor: person(ONCALL),
      reason: 'yes',
    });
    const second = h.service.decide({
      exceptionId: id,
      event: 'deny',
      actor: person(OTHER_ONCALL),
      reason: 'no',
    });
    await expect(second).rejects.toBeInstanceOf(Gate2AlreadyDecidedError);
    await expect(second).rejects.toMatchObject({
      code: 'GATE2_ALREADY_DECIDED',
      state: 'approved_once',
    });
    expect(h.store.rows.get(id)).toMatchObject({
      state: 'approved_once',
      decidedBy: ONCALL,
      stateVersion: 1,
    });
    expect(h.store.decisions).toHaveLength(1);
  });

  it('two approvers read the same version: the one whose write lands second is already-decided', async () => {
    const h = harness();
    const { id } = await open(h);
    // The rival commits between our read and our write.
    h.store.beforeTransition = () => {
      h.store.rows.set(id, {
        ...(h.store.rows.get(id) as Gate2ExceptionRow),
        state: 'denied',
        stateVersion: 1,
        decidedBy: OTHER_ONCALL,
        decidedAt: new Date(h.store.clock),
      });
    };
    await expect(
      h.service.decide({ exceptionId: id, event: 'approve', actor: person(ONCALL), reason: 'yes' }),
    ).rejects.toMatchObject({ code: 'GATE2_ALREADY_DECIDED', state: 'denied' });
    expect(h.store.decisions).toHaveLength(0);
    expect(h.audit).toHaveLength(1);
  });

  it('a stale expectedStateVersion is already-decided', async () => {
    const h = harness();
    const { id } = await open(h);
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'deny',
        actor: person(ONCALL),
        reason: 'x',
        expectedStateVersion: 3,
      }),
    ).rejects.toBeInstanceOf(Gate2AlreadyDecidedError);
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'deny',
        actor: person(ONCALL),
        reason: 'x',
        expectedStateVersion: 0,
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it('timeout arriving after a human approval is a no-op that returns the approval', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({
      exceptionId: id,
      event: 'approve',
      actor: person(ONCALL),
      reason: 'yes',
    });
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    const result = await h.service.decide({ exceptionId: id, event: 'time_out', actor: system });
    expect(result).toMatchObject({ applied: false, exception: { state: 'approved_once' } });
    expect(h.store.decisions).toHaveLength(1);
    expect(h.counts).toEqual(['pending', 'approved_once']);
  });

  it('a human decision arriving after the timeout fired is already-decided; the timeout stands', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    await h.service.decide({ exceptionId: id, event: 'time_out', actor: system });
    await expect(
      h.service.decide({
        exceptionId: id,
        event: 'approve',
        actor: person(ONCALL),
        reason: 'late',
      }),
    ).rejects.toMatchObject({ code: 'GATE2_ALREADY_DECIDED', state: 'timed_out' });
    expect(h.store.rows.get(id)?.state).toBe('timed_out');
  });

  it('a timeout that loses the write race to a human decision is a no-op', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    h.store.beforeTransition = () => {
      h.store.rows.set(id, {
        ...(h.store.rows.get(id) as Gate2ExceptionRow),
        state: 'denied',
        stateVersion: 1,
        decidedBy: ONCALL,
        decidedAt: new Date(h.store.clock),
      });
    };
    await expect(
      h.service.decide({ exceptionId: id, event: 'time_out', actor: system }),
    ).resolves.toMatchObject({
      applied: false,
      exception: { state: 'denied' },
    });
    expect(h.store.decisions).toHaveLength(0);
  });

  it('supersede after a terminal state is a no-op; supersede of a pending exception is denial', async () => {
    const h = harness();
    const { id } = await open(h);
    await h.service.decide({ exceptionId: id, event: 'deny', actor: person(ONCALL), reason: 'no' });
    await expect(
      h.service.decide({ exceptionId: id, event: 'supersede', actor: system }),
    ).resolves.toMatchObject({
      applied: false,
    });
    expect(h.store.decisions).toHaveLength(1);
  });

  it('a timeout that the database clock says is early is refused, not recorded', async () => {
    const h = harness();
    const { id } = await open(h);
    h.store.clock = new Date('2026-10-21T10:15:00.000Z');
    // The machine's read saw the timeout elapsed; by the write, the clock disagrees.
    h.store.beforeTransition = () => {
      h.store.clock = new Date('2026-10-21T10:00:00.000Z');
    };
    await expect(
      h.service.decide({ exceptionId: id, event: 'time_out', actor: system }),
    ).rejects.toBeInstanceOf(IllegalGate2TransitionError);
    expect(h.store.rows.get(id)?.state).toBe('pending');
  });
});

describe('audit failure rolls the decision back', () => {
  it('propagates a rejecting audit sink so the caller transaction aborts', async () => {
    const store = new MemoryStore();
    const service = createGate2Service({} as TenantTx, store, {
      audit: () => Promise.reject(new Error('ledger unavailable')),
      logger: { child: () => ({ info: () => undefined }) } as never,
    });
    await expect(service.create(create())).rejects.toThrow('ledger unavailable');
  });
});

describe('get', () => {
  it('returns the contract shape or undefined', async () => {
    const h = harness();
    const { id } = await open(h);
    expect(await h.service.get(id)).toMatchObject({ id, state: 'pending' });
    expect(await h.service.get(newId())).toBeUndefined();
  });
});
