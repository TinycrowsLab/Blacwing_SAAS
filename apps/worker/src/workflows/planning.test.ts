// Orchestration logic of PlanningWorkflow without a Temporal server: `@temporalio/workflow` is replaced by
// a minimal in-process runtime (activities are the real ones over in-memory ports; signals, queries and
// `condition` behave as Temporal's do for a single workflow). The same scenarios run against a real
// worker in planning.workflow.int.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlanningWorkflow } from './planning.js';
import {
  APPROVER,
  FakePlanner,
  MemoryPlans,
  MemoryRunState,
  MemorySas,
  REF,
  REQUESTER,
  makeActivities,
  makeHarness,
  sa,
  testCase,
  type Harness,
} from '../run/planning/testing.js';
import {
  GATE1_DECISION_SIGNAL,
  PLANNING_PROGRESS_QUERY,
  type Gate1DecisionSignal,
  type PlanningProgress,
  type PlanningResult,
} from '../run/planning/types.js';

const rt = vi.hoisted(() => {
  class CancelError extends Error {}
  class ApplicationFailure extends Error {
    constructor(
      message: string,
      readonly type: string,
    ) {
      super(message);
    }

    static nonRetryable(message: string, type: string): ApplicationFailure {
      return new ApplicationFailure(message, type);
    }
  }
  const state = {
    activities: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    handlers: new Map<string, (...args: never[]) => unknown>(),
    /** Ticks `condition` waits before it reports a timeout. */
    timeoutTicks: 20,
    cancelled: false,
  };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  return { CancelError, ApplicationFailure, state, tick };
});

vi.mock('@temporalio/workflow', () => ({
  ApplicationFailure: rt.ApplicationFailure,
  CancellationScope: { nonCancellable: <T>(fn: () => Promise<T>): Promise<T> => fn() },
  defineSignal: (name: string) => ({ name }),
  defineQuery: (name: string) => ({ name }),
  setHandler: (def: { name: string }, fn: (...args: never[]) => unknown) => {
    rt.state.handlers.set(def.name, fn);
  },
  isCancellation: (err: unknown) => err instanceof rt.CancelError,
  proxyActivities: () => rt.state.activities,
  condition: async (fn: () => boolean) => {
    for (let i = 0; i < rt.state.timeoutTicks; i++) {
      if (rt.state.cancelled) throw new rt.CancelError('cancelled');
      if (fn()) return true;
      await rt.tick();
    }
    return fn();
  },
}));

const manual = { sas: new MemorySas(sa({ preApprovedTestClasses: [] })) };

function start(h: Harness, input: { gate1TimeoutHours?: number } = {}): Promise<PlanningResult> {
  Object.assign(rt.state.activities, makeActivities(h));
  return PlanningWorkflow({ ...REF, ...input });
}

function signal(s: Gate1DecisionSignal): void {
  const handler = rt.state.handlers.get(GATE1_DECISION_SIGNAL) as (s: Gate1DecisionSignal) => void;
  handler(s);
}

const progress = (): PlanningProgress =>
  (rt.state.handlers.get(PLANNING_PROGRESS_QUERY) as () => PlanningProgress)();

/** Sends `s` once the workflow waits at Gate 1 for `round`. */
async function signalAtGate1(round: number, s: Gate1DecisionSignal): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const p = rt.state.handlers.has(PLANNING_PROGRESS_QUERY) ? progress() : undefined;
    if (p?.round === round && p.phase === 'awaiting_gate1') {
      signal(s);
      return;
    }
    await rt.tick();
  }
  throw new Error('workflow never reached Gate 1');
}

const approve = (planVersion = 1): Gate1DecisionSignal => ({
  actorId: APPROVER,
  planVersion,
  decision: 'approved',
});

beforeEach(() => {
  rt.state.handlers.clear();
  rt.state.timeoutTicks = 20;
  rt.state.cancelled = false;
});

describe('PlanningWorkflow orchestration', () => {
  it('auto-approves a plan inside the SA without waiting', async () => {
    const h = makeHarness();
    expect(await start(h)).toMatchObject({ outcome: 'approved', autoApproved: true, rounds: 1 });
    expect(h.runs.state).toBe('approved');
    expect(h.audit.actions()).toContain('gate1.requested');
  });

  it('waits for a human when the plan is not wholly inside the SA', async () => {
    const h = makeHarness(manual);
    const run = start(h);
    await signalAtGate1(1, approve());
    expect(await run).toMatchObject({ outcome: 'approved', autoApproved: false, planVersion: 1 });
    expect(h.decisions.rows[0]).toMatchObject({ auto: false, actorId: APPROVER });
  });

  it('the requester is refused and the run keeps waiting for another approver', async () => {
    const h = makeHarness({ ...manual, permissions: { canApprove: () => Promise.resolve(true) } });
    const run = start(h);
    await signalAtGate1(1, { ...approve(), actorId: REQUESTER });
    signal(approve());
    expect(await run).toMatchObject({ outcome: 'approved' });
    expect(h.decisions.rows.map((d) => d.actorId)).toEqual([APPROVER]);
    expect(h.audit.records.some((r) => r.metadata.code === 'SOD_VIOLATION')).toBe(true);
  });

  it('a timeout pages (repeatedly) and never approves; a later decision still completes', async () => {
    rt.state.timeoutTicks = 3;
    const h = makeHarness(manual);
    const run = start(h);
    for (let i = 0; i < 60 && h.pager.pages.length < 2; i++) await rt.tick();
    expect(h.decisions.rows).toHaveLength(0);
    expect(h.runs.state).toBe('awaiting_gate1');
    signal(approve());
    const result = await run;
    expect(result.gate1Pages).toBeGreaterThanOrEqual(2);
    expect(h.pager.pages.length).toBeGreaterThanOrEqual(2);
  });

  it('re-plans after a rejection and approves the next version', async () => {
    const h = makeHarness(manual);
    const run = start(h);
    await signalAtGate1(1, {
      actorId: APPROVER,
      planVersion: 1,
      decision: 'rejected',
      next: 'replan',
      reason: 'too wide',
    });
    await signalAtGate1(2, approve(2));
    expect(await run).toMatchObject({ outcome: 'approved', rounds: 2, planVersion: 2 });
    expect(h.plans.plans.map((p) => p.status)).toEqual(['rejected', 'frozen']);
    expect(h.planner.requests.map((r) => r.round)).toEqual([1, 2]);
  });

  it('a rejection that cancels ends the run cancelled', async () => {
    const h = makeHarness(manual);
    const run = start(h);
    await signalAtGate1(1, {
      actorId: APPROVER,
      planVersion: 1,
      decision: 'rejected',
      next: 'cancel',
      reason: 'no',
    });
    expect(await run).toMatchObject({ outcome: 'cancelled' });
    expect(h.runs.state).toBe('cancelled');
  });

  it('an approval after SA expiry ends the workflow in failure and the run in expired', async () => {
    const h = makeHarness({
      sas: new MemorySas(sa({ expiresAt: '2025-12-01T00:00:00.000Z', preApprovedTestClasses: [] })),
    });
    const run = start(h);
    const outcome = run.catch((err: unknown) => err);
    await signalAtGate1(1, approve());
    expect(await outcome).toMatchObject({ type: 'SA_EXPIRED' });
    expect(h.runs.state).toBe('expired');
    expect(h.envelopes.frozen).toHaveLength(0);
  });

  it('follows the run state when the first decision won but its reply was lost', async () => {
    const h = makeHarness(manual);
    const run = start(h);
    const decide = rt.state.activities.decideGate1;
    // The decision is applied, then the reply is lost: the retry sees a run that is no longer at Gate 1.
    rt.state.activities.decideGate1 = async (...args) => {
      await decide?.(...args);
      return decide?.(...args);
    };
    await signalAtGate1(1, approve());
    expect(await run).toMatchObject({ outcome: 'approved' });
    expect(h.envelopes.frozen).toHaveLength(1);
    expect(h.decisions.rows).toHaveLength(1);
  });

  describe('planner retries', () => {
    it('retries invalid output once with feedback, then persists', async () => {
      const h = makeHarness({
        planner: new FakePlanner([{ nope: 1 }, { testCases: [testCase()] }]),
      });
      expect(await start(h)).toMatchObject({ outcome: 'approved' });
      expect(h.planner.requests.map((r) => r.attempt)).toEqual([1, 2]);
      expect(h.planner.requests[1]?.feedback).toBeTruthy();
    });

    it('invalid output twice fails the run with PLAN_INVALID', async () => {
      const h = makeHarness({ planner: new FakePlanner([{ nope: 1 }]) });
      await expect(start(h)).rejects.toMatchObject({ type: 'PLAN_INVALID' });
      expect(h.planner.requests).toHaveLength(2);
      expect(h.runs.state).toBe('failed');
    });

    it('a destructive proposal never reaches Gate 1: retry once, then CLASS_FORBIDDEN', async () => {
      const h = makeHarness({
        planner: new FakePlanner([{ testCases: [testCase({ class: 'destructive' })] }]),
      });
      await expect(start(h)).rejects.toMatchObject({ type: 'CLASS_FORBIDDEN' });
      expect(h.plans.plans).toHaveLength(0);
      expect(h.runs.state).toBe('failed');
    });

    it('an empty plan fails with PLAN_EMPTY and is not retried', async () => {
      const h = makeHarness({ planner: new FakePlanner([{ testCases: [] }]) });
      await expect(start(h)).rejects.toMatchObject({ type: 'PLAN_EMPTY' });
      expect(h.planner.requests).toHaveLength(1);
      expect(h.runs.state).toBe('failed');
    });
  });

  it('a cancelled workflow stops the planner session', async () => {
    const h = makeHarness(manual);
    const run = start(h);
    const outcome = run.catch((err: unknown) => err);
    await signalAtGate1(1, { ...approve(), actorId: REQUESTER }); // refused: still waiting
    rt.state.cancelled = true;
    expect(await outcome).toBeInstanceOf(rt.CancelError);
    expect(h.planner.aborted).toEqual([REF.runId]);
  });

  it('exposes progress through the query', async () => {
    const h = makeHarness({ ...manual, plans: new MemoryPlans(), runs: new MemoryRunState() });
    const run = start(h);
    await signalAtGate1(1, approve());
    await run;
    expect(progress()).toMatchObject({ phase: 'approved', round: 1 });
  });
});
