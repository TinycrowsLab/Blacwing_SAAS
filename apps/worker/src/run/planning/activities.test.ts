import { describe, expect, it } from 'vitest';

import {
  APPROVER,
  EXPIRED_AT,
  FakePermissions,
  FakePlanner,
  MemoryPlans,
  MemoryRunState,
  MemorySas,
  REF,
  REQUESTED_AT,
  REQUESTER,
  SA_ID,
  makeActivities,
  makeHarness,
  sa,
  testCase,
} from './testing.js';

import type { Gate1DecisionSignal } from './types.js';

const approval = (
  over: { actorId?: string; planVersion?: number; reason?: string } = {},
): Gate1DecisionSignal => ({ actorId: APPROVER, planVersion: 1, decision: 'approved', ...over });
const rejection = (next: 'replan' | 'cancel'): Gate1DecisionSignal => ({
  actorId: APPROVER,
  planVersion: 1,
  decision: 'rejected',
  next,
  reason: 'scope too broad',
});

/** A harness whose run waits at Gate 1 with a persisted plan (version 1). */
async function atGate1(over: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(over);
  const acts = makeActivities(h);
  const proposed = await acts.proposePlan({ ...REF, round: 1, attempt: 1 });
  if (proposed.outcome !== 'persisted') throw new Error('plan was not persisted');
  await acts.requestGate1({ ...REF, planId: proposed.planId, version: proposed.version });
  return { h, acts, planId: proposed.planId, version: proposed.version };
}

describe('proposePlan', () => {
  it('asks the planner for json_schema output, persists every §7 field as proposed and audits it', async () => {
    const h = makeHarness();
    const acts = makeActivities(h);
    const result = await acts.proposePlan({ ...REF, round: 1, attempt: 1 });
    expect(result).toEqual({
      outcome: 'persisted',
      planId: 'plan-1',
      version: 1,
      testCaseCount: 1,
    });
    expect(h.planner.requests[0]?.outputFormat).toMatchObject({
      type: 'json_schema',
      schema: { type: 'object' },
    });
    const stored = h.plans.plans[0];
    expect(stored?.frozen).toBe(false);
    expect(stored?.caseStatus).toBe('proposed');
    expect(stored?.testCases[0]).toEqual(testCase());
    expect(h.audit.actions()).toEqual(['plan.proposed']);
    expect(h.metrics.cases).toEqual([['active_safe', 1]]);
  });

  it('counts a retried activity once and keeps one plan per round', async () => {
    const h = makeHarness();
    const acts = makeActivities(h);
    await acts.proposePlan({ ...REF, round: 1, attempt: 1 });
    await acts.proposePlan({ ...REF, round: 1, attempt: 1 });
    expect(h.plans.plans).toHaveLength(1);
    expect(h.metrics.cases).toHaveLength(1);
    expect(h.audit.actions()).toEqual(['plan.proposed']);
  });

  it('rejects invalid output without persisting it and hands the planner feedback on the retry', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ nope: true }, { testCases: [testCase()] }]),
    });
    const acts = makeActivities(h);
    const first = await acts.proposePlan({ ...REF, round: 1, attempt: 1 });
    expect(first).toMatchObject({ outcome: 'rejected', code: 'PLAN_INVALID' });
    expect(h.plans.plans).toHaveLength(0);
    const second = await acts.proposePlan({
      ...REF,
      round: 1,
      attempt: 2,
      feedback: first.outcome === 'rejected' ? first.detail : '',
    });
    expect(second.outcome).toBe('persisted');
    expect(h.planner.requests[1]?.feedback).toContain('testCases');
    expect(h.audit.records.map((r) => r.outcome)).toEqual(['failure', 'success']);
  });

  it('rejects a destructive case with CLASS_FORBIDDEN and persists nothing (§8.3)', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ testCases: [testCase(), testCase({ class: 'destructive' })] }]),
    });
    const result = await makeActivities(h).proposePlan({ ...REF, round: 1, attempt: 1 });
    expect(result).toMatchObject({ outcome: 'rejected', code: 'CLASS_FORBIDDEN' });
    expect(h.plans.plans).toHaveLength(0);
  });

  it('rejects an empty plan with PLAN_EMPTY', async () => {
    const h = makeHarness({ planner: new FakePlanner([{ testCases: [] }]) });
    expect(await makeActivities(h).proposePlan({ ...REF, round: 1, attempt: 1 })).toMatchObject({
      outcome: 'rejected',
      code: 'PLAN_EMPTY',
    });
  });

  it('rejects a class above the SA ceiling', async () => {
    const h = makeHarness({
      sas: new MemorySas(sa({ maxIntrusiveness: 'active_safe' })),
      planner: new FakePlanner([{ testCases: [testCase({ class: 'state_changing' })] }]),
    });
    expect(await makeActivities(h).proposePlan({ ...REF, round: 1, attempt: 1 })).toMatchObject({
      code: 'CLASS_EXCEEDS_SA',
    });
  });

  it('lets a planner that cannot answer surface so Temporal retries', async () => {
    const h = makeHarness({ planner: new FakePlanner([new Error('session crashed')]) });
    await expect(makeActivities(h).proposePlan({ ...REF, round: 1, attempt: 1 })).rejects.toThrow(
      'session crashed',
    );
  });

  it('fails when the run or its SA is not found for the tenant', async () => {
    const h = makeHarness({ sas: new MemorySas(null) });
    await expect(makeActivities(h).proposePlan({ ...REF, round: 1, attempt: 1 })).rejects.toThrow();
  });
});

describe('requestGate1 and failPlanning', () => {
  it('moves planning to awaiting_gate1 once and audits gate1.requested', async () => {
    const { h, acts, planId, version } = await atGate1();
    await acts.requestGate1({ ...REF, planId, version });
    expect(h.runs.state).toBe('awaiting_gate1');
    expect(h.audit.actions().filter((a) => a === 'gate1.requested')).toHaveLength(1);
    expect(h.audit.actions().filter((a) => a === 'run.state_changed')).toHaveLength(1);
  });

  it('a lost state race is retried, not swallowed', async () => {
    const h = makeHarness();
    h.runs.failNextSave = true;
    await expect(
      makeActivities(h).requestGate1({ ...REF, planId: 'p', version: 1 }),
    ).rejects.toThrow();
  });

  it('failPlanning fails the run with the code audited', async () => {
    const h = makeHarness();
    await makeActivities(h).failPlanning({ ...REF, code: 'PLAN_EMPTY' });
    expect(h.runs.state).toBe('failed');
    expect(h.audit.records.at(-1)).toMatchObject({
      outcome: 'failure',
      metadata: { code: 'PLAN_EMPTY' },
    });
  });
});

describe('autoApprove', () => {
  it('approves under the SA, records auto=true, freezes the plan and the envelope', async () => {
    const { h, acts, planId, version } = await atGate1();
    expect(await acts.autoApprove({ ...REF, planId, version })).toEqual({ approved: true });
    expect(h.runs.state).toBe('approved');
    expect(h.decisions.rows).toEqual([
      expect.objectContaining({
        decision: 'approved',
        auto: true,
        actorId: null,
        reason: `approved under SA-${SA_ID}`,
        planVersion: 1,
      }),
    ]);
    expect(h.plans.plans[0]).toMatchObject({ frozen: true, caseStatus: 'approved' });
    expect(h.envelopes.frozen).toEqual([
      expect.objectContaining({
        planId,
        planVersion: 1,
        saId: SA_ID,
        auto: true,
        approvedBy: null,
        pins: { 'planner.prompt': 'sha256:abc' },
      }),
    ]);
    expect(h.envelopes.frozen[0]?.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.metrics.decisions).toEqual([['approved', true]]);
    expect(h.audit.records.find((r) => r.action === 'gate1.decided')).toMatchObject({
      outcome: 'success',
      metadata: { auto: true, decision: 'approved' },
    });
  });

  it('is idempotent: a retry after approval changes nothing', async () => {
    const { h, acts, planId, version } = await atGate1();
    await acts.autoApprove({ ...REF, planId, version });
    expect(await acts.autoApprove({ ...REF, planId, version })).toEqual({ approved: true });
    expect(h.decisions.rows).toHaveLength(1);
    expect(h.envelopes.frozen).toHaveLength(1);
    expect(h.metrics.decisions).toHaveLength(1);
  });

  it.each([
    [
      'one class is not pre-approved',
      { testCases: [testCase(), testCase({ class: 'passive' })] },
      { preApprovedTestClasses: ['active_safe'] },
    ],
    [
      'a budget exceeds the SA',
      {
        testCases: [
          testCase({
            budget: { maxRequests: 5000, maxRps: 5, maxConcurrency: 2, maxBytes: 10_000 },
          }),
        ],
      },
      {},
    ],
    [
      'a state_changing case is present, even if the SA lists it',
      { testCases: [testCase({ class: 'state_changing' })] },
      { preApprovedTestClasses: ['active_safe', 'state_changing'] },
    ],
    ['the SA has expired', { testCases: [testCase()] }, { expiresAt: EXPIRED_AT }],
    ['the SA is no longer active', { testCases: [testCase()] }, { status: 'revoked' as const }],
  ])('needs a human when %s', async (_name, output, saOver) => {
    const { h, acts, planId, version } = await atGate1({
      planner: new FakePlanner([output]),
      sas: new MemorySas(sa(saOver)),
    });
    expect(await acts.autoApprove({ ...REF, planId, version })).toEqual({ approved: false });
    expect(h.runs.state).toBe('awaiting_gate1');
    expect(h.decisions.rows).toHaveLength(0);
    expect(h.envelopes.frozen).toHaveLength(0);
    expect(h.plans.plans[0]?.frozen).toBe(false);
  });

  it('never trusts the caller: a stale plan version is not auto-approved', async () => {
    const { h, acts, planId } = await atGate1();
    expect(await acts.autoApprove({ ...REF, planId, version: 99 })).toEqual({ approved: false });
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it('is a no-op for a run that is not at Gate 1', async () => {
    const h = makeHarness();
    expect(await makeActivities(h).autoApprove({ ...REF, planId: 'plan-1', version: 1 })).toEqual({
      approved: false,
    });
  });
});

describe('decideGate1: authorisation', () => {
  it('refuses the requester with SOD_VIOLATION and changes nothing (§8.4)', async () => {
    const { h, acts } = await atGate1({ permissions: new FakePermissions([REQUESTER, APPROVER]) });
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval({ actorId: REQUESTER }),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'SOD_VIOLATION', terminal: false });
    expect(h.runs.state).toBe('awaiting_gate1');
    expect(h.decisions.rows).toHaveLength(0);
    expect(h.envelopes.frozen).toHaveLength(0);
    expect(h.audit.records.at(-1)).toMatchObject({
      action: 'gate1.decided',
      outcome: 'failure',
      actorId: REQUESTER,
      metadata: { code: 'SOD_VIOLATION' },
    });
  });

  it('fails closed when the requester is unknown', async () => {
    const { h, acts } = await atGate1({ runs: new MemoryRunState('planning', null) });
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'SOD_VIOLATION' });
    expect(h.envelopes.frozen).toHaveLength(0);
  });

  it('refuses an approver without the Gate 1 permission with FORBIDDEN', async () => {
    const { h, acts } = await atGate1({ permissions: new FakePermissions([]) });
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'FORBIDDEN' });
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it.each([
    ['an unknown decision', { actorId: APPROVER, planVersion: 1, decision: 'maybe' }],
    [
      'a rejection without a reason',
      { actorId: APPROVER, planVersion: 1, decision: 'rejected', next: 'cancel' },
    ],
    [
      'a rejection with a blank reason',
      { actorId: APPROVER, planVersion: 1, decision: 'rejected', next: 'cancel', reason: '  ' },
    ],
    ['a missing plan version', { actorId: APPROVER, decision: 'approved' }],
    [
      'an unexpected field',
      { actorId: APPROVER, planVersion: 1, decision: 'approved', auto: true },
    ],
    ['a non-object', 'approve'],
  ])('refuses a malformed signal: %s', async (_name, signal) => {
    const { h, acts } = await atGate1();
    const verdict = await acts.decideGate1({
      ...REF,
      signal: signal as Gate1DecisionSignal,
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'GATE1_SIGNAL_INVALID' });
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it('refuses a decision when the run is not waiting at Gate 1 and reports where it is', async () => {
    const h = makeHarness();
    const verdict = await makeActivities(h).decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({
      accepted: false,
      code: 'GATE1_RUN_NOT_AWAITING',
      terminal: false,
      runState: 'planning',
    });
  });
});

describe('decideGate1: approval', () => {
  it('approves, freezes the plan version, writes the envelope and moves the run to approved', async () => {
    const { h, acts } = await atGate1();
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval({ reason: 'looks right' }),
      requestedAt: '2026-01-01T11:58:30.000Z',
    });
    expect(verdict).toEqual({ accepted: true, outcome: 'approved' });
    expect(h.runs.state).toBe('approved');
    expect(h.plans.plans[0]).toMatchObject({ frozen: true, caseStatus: 'approved' });
    expect(h.envelopes.frozen[0]).toMatchObject({
      planVersion: 1,
      saId: SA_ID,
      approvedBy: APPROVER,
      auto: false,
    });
    expect(h.decisions.rows[0]).toMatchObject({
      decision: 'approved',
      actorId: APPROVER,
      auto: false,
      reason: 'looks right',
    });
    expect(h.metrics.decisions).toEqual([['approved', false]]);
    expect(h.metrics.waits).toEqual([90]);
    expect(h.audit.records.find((r) => r.action === 'gate1.decided')).toMatchObject({
      actorId: APPROVER,
      outcome: 'success',
      metadata: { decision: 'approved', auto: false, planVersion: 1 },
    });
  });

  it('a state_changing plan is approved only by an explicit human decision', async () => {
    const { h, acts, planId, version } = await atGate1({
      planner: new FakePlanner([{ testCases: [testCase({ class: 'state_changing' })] }]),
      sas: new MemorySas(sa({ preApprovedTestClasses: ['active_safe', 'state_changing'] })),
    });
    expect(await acts.autoApprove({ ...REF, planId, version })).toEqual({ approved: false });
    expect(
      await acts.decideGate1({ ...REF, signal: approval(), requestedAt: REQUESTED_AT }),
    ).toEqual({
      accepted: true,
      outcome: 'approved',
    });
    expect(h.decisions.rows[0]?.auto).toBe(false);
  });

  it('duplicate approval signals: the first wins, the second is refused by the state machine', async () => {
    const { h, acts } = await atGate1();
    await acts.decideGate1({ ...REF, signal: approval(), requestedAt: REQUESTED_AT });
    const second = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(second).toMatchObject({
      accepted: false,
      code: 'GATE1_RUN_NOT_AWAITING',
      runState: 'approved',
    });
    expect(h.decisions.rows).toHaveLength(1);
    expect(h.envelopes.frozen).toHaveLength(1);
    expect(h.metrics.decisions).toHaveLength(1);
  });

  it('refuses an approval of a stale plan version (concurrent edit during Gate 1)', async () => {
    const { h, acts } = await atGate1();
    h.plans.edit();
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval({ planVersion: 1 }),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'PLAN_VERSION_CONFLICT' });
    expect(h.runs.state).toBe('awaiting_gate1');
    expect(h.envelopes.frozen).toHaveLength(0);
  });

  it('refuses when the plan changes between the version check and the freeze', async () => {
    const plans = new MemoryPlans();
    const { h, acts } = await atGate1({ plans });
    const freeze = plans.freeze.bind(plans);
    plans.freeze = (t, r, planId, v) => {
      plans.edit();
      return freeze(t, r, planId, v);
    };
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'PLAN_VERSION_CONFLICT' });
    expect(h.envelopes.frozen).toHaveLength(0);
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it('an approval after SA expiry is refused and the run moves to expired', async () => {
    const { h, acts } = await atGate1({ sas: new MemorySas(sa({ expiresAt: EXPIRED_AT })) });
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'SA_EXPIRED', terminal: true });
    expect(h.runs.state).toBe('expired');
    expect(h.envelopes.frozen).toHaveLength(0);
    // A retry of the same signal lands on a terminal run and says so.
    expect(
      await acts.decideGate1({ ...REF, signal: approval(), requestedAt: REQUESTED_AT }),
    ).toMatchObject({
      code: 'GATE1_RUN_NOT_AWAITING',
      terminal: true,
      runState: 'expired',
    });
  });

  it('refuses an approval when the SA is no longer active', async () => {
    const { h, acts } = await atGate1({ sas: new MemorySas(sa({ status: 'revoked' })) });
    const verdict = await acts.decideGate1({
      ...REF,
      signal: approval(),
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'SA_NOT_ACTIVE' });
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it('a retry after a crash between the writes completes the approval without duplicates', async () => {
    const { h, acts } = await atGate1();
    h.runs.failNextSave = true;
    await expect(
      acts.decideGate1({ ...REF, signal: approval(), requestedAt: REQUESTED_AT }),
    ).rejects.toThrow();
    expect(h.envelopes.frozen).toHaveLength(1);
    expect(
      await acts.decideGate1({ ...REF, signal: approval(), requestedAt: REQUESTED_AT }),
    ).toEqual({
      accepted: true,
      outcome: 'approved',
    });
    expect(h.runs.state).toBe('approved');
    expect(h.envelopes.frozen).toHaveLength(1);
    expect(h.decisions.rows).toHaveLength(1);
  });
});

describe('decideGate1: rejection', () => {
  it('re-plan sends the run back to planning and keeps the rejected plan unfrozen', async () => {
    const { h, acts } = await atGate1();
    expect(
      await acts.decideGate1({ ...REF, signal: rejection('replan'), requestedAt: REQUESTED_AT }),
    ).toEqual({
      accepted: true,
      outcome: 'replan',
    });
    expect(h.runs.state).toBe('planning');
    expect(h.plans.plans[0]).toMatchObject({ status: 'rejected', frozen: false });
    expect(h.envelopes.frozen).toHaveLength(0);
    expect(h.decisions.rows[0]).toMatchObject({ decision: 'rejected', reason: 'scope too broad' });
    expect(h.metrics.decisions).toEqual([['rejected', false]]);
  });

  it('cancel ends the run as cancelled', async () => {
    const { h, acts } = await atGate1();
    expect(
      await acts.decideGate1({ ...REF, signal: rejection('cancel'), requestedAt: REQUESTED_AT }),
    ).toEqual({
      accepted: true,
      outcome: 'cancelled',
    });
    expect(h.runs.state).toBe('cancelled');
  });

  it('the requester cannot reject either (SoD applies to every Gate 1 decision)', async () => {
    const { h, acts } = await atGate1();
    const verdict = await acts.decideGate1({
      ...REF,
      signal: { ...rejection('cancel'), actorId: REQUESTER },
      requestedAt: REQUESTED_AT,
    });
    expect(verdict).toMatchObject({ accepted: false, code: 'SOD_VIOLATION' });
    expect(h.runs.state).toBe('awaiting_gate1');
  });

  it('a second plan version can be proposed and approved after a re-plan', async () => {
    const { h, acts } = await atGate1();
    await acts.decideGate1({ ...REF, signal: rejection('replan'), requestedAt: REQUESTED_AT });
    const next = await acts.proposePlan({ ...REF, round: 2, attempt: 1 });
    expect(next).toMatchObject({ outcome: 'persisted', version: 2 });
    await acts.requestGate1({ ...REF, planId: 'plan-2', version: 2 });
    await acts.decideGate1({
      ...REF,
      signal: approval({ planVersion: 2 }),
      requestedAt: REQUESTED_AT,
    });
    expect(h.runs.state).toBe('approved');
    expect(h.envelopes.frozen[0]?.planVersion).toBe(2);
  });
});

describe('timeout and abort', () => {
  it('pages on a Gate 1 timeout and approves nothing', async () => {
    const { h, acts } = await atGate1();
    await acts.pageGate1Timeout({ ...REF, page: 1 });
    expect(h.pager.pages).toHaveLength(1);
    expect(h.runs.state).toBe('awaiting_gate1');
    expect(h.decisions.rows).toHaveLength(0);
    expect(h.audit.records.at(-1)).toMatchObject({
      action: 'gate1.decided',
      outcome: 'failure',
      metadata: { decision: 'timeout_paged' },
    });
  });

  it('abortPlanning stops the planner session', async () => {
    const h = makeHarness();
    await makeActivities(h).abortPlanning(REF);
    expect(h.planner.aborted).toEqual([REF.runId]);
  });
});
