import { describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { FixedClock } from '@blackwing/time';

import { Gate1Error } from './errors.js';
import { InMemoryGate1AuditSink, InMemoryGate1Store } from './memory.js';
import { Gate1Service } from './service.js';

import type { Gate1Plan, Gate1Principal, Gate1RunRecord } from './ports.js';
import type { Gate1TestCase, RunState } from '@blackwing/contracts';

const TENANT = '0190a5d0-1111-7111-8111-111111111111';
const OTHER_TENANT = '0190a5d0-2222-7222-8222-222222222222';
const RUN = 'run_01jbz3k6w8f5r4t2n9q7x0m1ab';
const REQUESTER = 'user-requester';
const APPROVER = 'user-approver';
const NOW = '2026-10-29T10:00:00.000Z';
const FUTURE = '2026-10-29T12:00:00.000Z';
const PAST = '2026-10-29T09:00:00.000Z';
const KEY = 'gate1-decision-0001';

const budget = { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1000 };

function testCase(id: string, over: Partial<Gate1TestCase> = {}): Gate1TestCase {
  return {
    id,
    title: `Check ${id}`,
    class: 'passive',
    targets: ['https://lab.example.test/app'],
    budget,
    ...over,
  };
}

const planOf = (
  planVersion: number,
  testCases: Gate1TestCase[],
  expiresAt: string | null = FUTURE,
): Gate1Plan => ({
  planVersion,
  requestedAt: '2026-10-29T08:00:00.000Z',
  expiresAt,
  testCases,
});

function runOf(over: Partial<Gate1RunRecord> = {}): Gate1RunRecord {
  return {
    id: RUN,
    tenantId: TENANT,
    state: 'awaiting_gate1',
    stateVersion: 7,
    requesterId: REQUESTER,
    plan: planOf(2, [testCase('tc-1'), testCase('tc-2', { class: 'active_safe' })]),
    priorPlan: null,
    ...over,
  };
}

const principal = (over: Partial<Gate1Principal> = {}): Gate1Principal => ({
  type: 'user',
  id: APPROVER,
  tenantId: TENANT,
  roles: ['asset_owner'],
  ...over,
});

const REQUEST = { decision: 'approve', planVersion: 2 } as const;

function harness(run: Gate1RunRecord | null = runOf(), now = NOW) {
  const store = new InMemoryGate1Store(run === null ? [] : [run]);
  const audit = new InMemoryGate1AuditSink();
  const service = new Gate1Service({ store, audit, clock: new FixedClock(now) });
  return { store, audit, service };
}

async function captured(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('Gate1Service.getPlan', () => {
  it('shows the plan, budget totals and that an approver may decide', async () => {
    const { service } = harness();
    const view = await service.getPlan(principal(), RUN);
    expect(view).toMatchObject({
      runId: RUN,
      runState: 'awaiting_gate1',
      planVersion: 2,
      requesterId: REQUESTER,
      expiresAt: FUTURE,
      changes: null,
      viewer: { canDecide: true, isRequester: false },
    });
    expect(view.testCases.map((t) => t.id)).toEqual(['tc-1', 'tc-2']);
    expect(view.budgetTotals).toEqual({ maxRequests: 200, maxBytes: 2000 });
  });

  it('tells the requester they cannot decide their own plan', async () => {
    const { service } = harness();
    const view = await service.getPlan(principal({ id: REQUESTER, roles: ['asset_owner'] }), RUN);
    expect(view.viewer).toEqual({ canDecide: false, isRequester: true });
  });

  it('gives a read-only view to a caller without testplan:approve', async () => {
    const { service } = harness();
    const view = await service.getPlan(principal({ roles: ['developer'] }), RUN);
    expect(view.viewer).toEqual({ canDecide: false, isRequester: false });
  });

  it('refuses a caller without testplan:read', async () => {
    const { service } = harness();
    const error = await captured(service.getPlan(principal({ roles: ['no_such_role'] }), RUN));
    expect(error.code).toBe('FORBIDDEN');
  });

  it('fails closed without a tenant context', async () => {
    const { service } = harness();
    const error = await captured(service.getPlan(principal({ tenantId: null }), RUN));
    expect(error.code).toBe('TENANT_CONTEXT_MISSING');
  });

  it('answers 404 for a malformed id, a missing run and another tenant run (no existence leak)', async () => {
    const { service } = harness();
    expect((await captured(service.getPlan(principal(), 'not-a-run'))).code).toBe('NOT_FOUND');
    expect((await captured(service.getPlan(principal(), 'run_missing0000'))).code).toBe(
      'NOT_FOUND',
    );
    expect((await captured(service.getPlan(principal({ tenantId: OTHER_TENANT }), RUN))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('does not offer a decision once the run has left Gate 1 or the window closed', async () => {
    const left = harness(runOf({ state: 'planning' }));
    expect((await left.service.getPlan(principal(), RUN)).viewer.canDecide).toBe(false);
    const expired = harness(runOf({ plan: planOf(2, [testCase('tc-1')], PAST) }));
    expect((await expired.service.getPlan(principal(), RUN)).viewer.canDecide).toBe(false);
  });

  it('shows what changed since the prior plan version', async () => {
    const prior = planOf(1, [testCase('tc-1'), testCase('tc-old')]);
    const current = planOf(2, [testCase('tc-1', { title: 'Renamed' }), testCase('tc-new')]);
    const { service } = harness(runOf({ plan: current, priorPlan: prior }));
    const view = await service.getPlan(principal(), RUN);
    expect(view.changes).toEqual({
      fromVersion: 1,
      added: ['tc-new'],
      removed: ['tc-old'],
      changed: ['tc-1'],
    });
  });
});

describe('Gate1Service.decide', () => {
  const decide = (
    service: Gate1Service,
    over: Partial<{
      principal: Gate1Principal;
      runId: string;
      body: unknown;
      idempotencyKey: string | undefined;
    }> = {},
  ) =>
    service.decide({
      principal: over.principal ?? principal(),
      runId: over.runId ?? RUN,
      body: 'body' in over ? over.body : REQUEST,
      idempotencyKey: 'idempotencyKey' in over ? over.idempotencyKey : KEY,
      traceId: null,
    });

  it('lets a different approver approve: the run moves to approved and is audited', async () => {
    const { service, store, audit } = harness();
    const response = await decide(service);
    expect(response).toEqual({
      runId: RUN,
      decision: 'approve',
      planVersion: 2,
      runState: 'approved',
      decidedAt: NOW,
    });
    expect((await store.getRun(TENANT, RUN))?.state).toBe('approved');
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: 'gate1.decided',
      outcome: 'success',
      tenantId: TENANT,
      actor: { type: 'user', id: APPROVER },
      target: { type: 'run', id: RUN },
      metadata: { decision: 'approve', planVersion: 2, toState: 'approved', reasonProvided: false },
    });
  });

  it.each([
    ['request_changes', 'planning'],
    ['reject', 'cancelled'],
  ] as const)('%s moves the run to %s', async (decision, expected: RunState) => {
    const { service, store } = harness();
    const response = await decide(service, {
      body: { decision, planVersion: 2, reason: 'Scope the admin panel out.' },
    });
    expect(response.runState).toBe(expected);
    expect((await store.getRun(TENANT, RUN))?.state).toBe(expected);
  });

  it.each(['request_changes', 'reject'] as const)('%s needs a reason', async (decision) => {
    const { service, store, audit } = harness();
    const error = await captured(decide(service, { body: { decision, planVersion: 2 } }));
    expect(error.code).toBe('VALIDATION_FAILED');
    const blank = await captured(
      decide(service, { body: { decision, planVersion: 2, reason: '   ' } }),
    );
    expect(blank.code).toBe('VALIDATION_FAILED');
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
    expect(audit.records).toHaveLength(0);
  });

  it('refuses the requester approving their own plan with SOD_VIOLATION, unchanged, and audits the refusal', async () => {
    const { service, store, audit } = harness();
    const error = await captured(decide(service, { principal: principal({ id: REQUESTER }) }));
    expect(error).toBeInstanceOf(Gate1Error);
    expect(error.code).toBe('SOD_VIOLATION');
    expect(error.httpStatus).toBe(403);
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
    expect(audit.records).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        actor: { type: 'user', id: REQUESTER },
        metadata: { code: 'SOD_VIOLATION', decision: 'approve' },
      }),
    ]);
  });

  it('fails closed when the requester is unknown: nobody can self-approve an unattributed plan', async () => {
    const { service } = harness(runOf({ requesterId: null }));
    const error = await captured(decide(service));
    expect(error.code).toBe('SOD_VIOLATION');
  });

  it('refuses a caller without testplan:approve (developer, requester role) with FORBIDDEN', async () => {
    const { service, store, audit } = harness();
    const error = await captured(
      decide(service, { principal: principal({ roles: ['developer'] }) }),
    );
    expect(error.code).toBe('FORBIDDEN');
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
    expect(audit.records[0]?.outcome).toBe('denied');
  });

  it('refuses a missing or too-short Idempotency-Key before touching the run', async () => {
    const { service, audit } = harness();
    expect((await captured(decide(service, { idempotencyKey: undefined }))).code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect((await captured(decide(service, { idempotencyKey: 'short' }))).code).toBe(
      'IDEMPOTENCY_KEY_REQUIRED',
    );
    expect(audit.records).toHaveLength(0);
  });

  it('refuses a plan version other than the one reviewed (stale plan) and leaves the run unchanged', async () => {
    const { service, store, audit } = harness();
    const error = await captured(
      decide(service, { body: { decision: 'approve', planVersion: 1 } }),
    );
    expect(error.code).toBe('GATE1_PLAN_STALE');
    expect(error.httpStatus).toBe(409);
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
    expect(audit.records[0]?.metadata.code).toBe('GATE1_PLAN_STALE');
  });

  it('refuses a run that is no longer awaiting Gate 1 (already decided) with GATE1_NOT_PENDING', async () => {
    const { service } = harness(runOf({ state: 'approved' }));
    const error = await captured(decide(service));
    expect(error.code).toBe('GATE1_NOT_PENDING');
    expect(error.httpStatus).toBe(409);
  });

  it('refuses a decision after the approval window closed (expired Gate 1)', async () => {
    const { service, store } = harness(runOf({ plan: planOf(2, [testCase('tc-1')], PAST) }));
    const error = await captured(decide(service));
    expect(error.code).toBe('GATE1_EXPIRED');
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
  });

  it('is idempotent: the same key and body replay the first answer and write nothing new', async () => {
    const { service, audit } = harness();
    const first = await decide(service);
    const second = await decide(service);
    expect(second).toEqual(first);
    expect(audit.records.filter((r) => r.outcome === 'success')).toHaveLength(1);
  });

  it('answers a double submit (two concurrent requests, one key) with one decision', async () => {
    const { service, audit } = harness();
    const [a, b] = await Promise.all([decide(service), decide(service)]);
    expect(b).toEqual(a);
    expect(audit.records.filter((r) => r.outcome === 'success')).toHaveLength(1);
  });

  it('refuses a key reused for a different decision with IDEMPOTENCY_KEY_MISMATCH', async () => {
    const { service } = harness();
    await decide(service);
    const error = await captured(
      decide(service, { body: { decision: 'reject', planVersion: 2, reason: 'Changed my mind.' } }),
    );
    expect(error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(error.httpStatus).toBe(422);
  });

  it('lets only one of two different approvers win the race; the loser gets GATE1_NOT_PENDING', async () => {
    const { service, audit } = harness();
    const results = await Promise.allSettled([
      decide(service, {
        principal: principal({ id: 'approver-a' }),
        idempotencyKey: 'key-approver-a',
      }),
      decide(service, {
        principal: principal({ id: 'approver-b' }),
        idempotencyKey: 'key-approver-b',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'GATE1_NOT_PENDING' });
    expect(audit.records.filter((r) => r.outcome === 'success')).toHaveLength(1);
  });

  it('never decides another tenant run: 404 and no change', async () => {
    const { service, store, audit } = harness();
    const error = await captured(
      decide(service, { principal: principal({ tenantId: OTHER_TENANT }) }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect((await store.getRun(TENANT, RUN))?.state).toBe('awaiting_gate1');
    expect(audit.records).toHaveLength(0);
  });

  it('fails closed without a tenant context', async () => {
    const { service } = harness();
    const error = await captured(decide(service, { principal: principal({ tenantId: null }) }));
    expect(error.code).toBe('TENANT_CONTEXT_MISSING');
  });

  it('rejects a body with unknown fields (no smuggled state or requester)', async () => {
    const { service } = harness();
    const error = await captured(
      decide(service, { body: { decision: 'approve', planVersion: 2, runState: 'released' } }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});
