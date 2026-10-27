// ORCH-005 (#229) integration: PlanningWorkflow on a real Temporal worker with the real activities over
// in-memory ports (the planner session, plan tables, RBAC and paging are stubbed). Needs `pnpm dev:deps`
// (temporal + temporal-bootstrap). TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APPROVER,
  FakePlanner,
  MemorySas,
  REF,
  REQUESTER,
  makeActivities,
  makeHarness,
  sa,
  testCase,
  type Harness,
} from './testing.js';
import {
  GATE1_DECISION_SIGNAL,
  PLANNING_PROGRESS_QUERY,
  PLANNING_WORKFLOW,
  type Gate1DecisionSignal,
  type PlanningProgress,
  type PlanningResult,
} from './types.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const POLL_MS = 100;

describe('PlanningWorkflow on Temporal', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
  });

  afterAll(async () => {
    await connection.close();
    await native.close();
  });

  /**
   * Runs the workflow. Each `signals` entry is sent once the run waits at Gate 1 for its
   * `planVersion` (after a re-plan the workflow waits again, at the next round). Returns the result, or the failure.
   */
  async function run(
    h: Harness,
    signals: readonly Gate1DecisionSignal[],
    opts: { gate1TimeoutHours?: number; signalDelayMs?: number } = {},
  ): Promise<PlanningResult | Error> {
    const taskQueue = `bw-planning-${randomUUID()}`;
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../../workflows/index.ts', import.meta.url)),
      activities: makeActivities(h),
    });
    return worker.runUntil(async () => {
      const handle = await client.workflow.start(PLANNING_WORKFLOW, {
        taskQueue,
        workflowId: `planning-${randomUUID()}`,
        args: [{ ...REF, gate1TimeoutHours: opts.gate1TimeoutHours }],
      });
      for (const signal of signals) {
        const round = signal.planVersion;
        for (;;) {
          const p = await handle.query<PlanningProgress>(PLANNING_PROGRESS_QUERY);
          if (p.phase === 'approved' || p.phase === 'cancelled') break;
          if (p.round === round && p.phase === 'awaiting_gate1') break;
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        await new Promise((r) => setTimeout(r, opts.signalDelayMs ?? 0));
        await handle.signal(GATE1_DECISION_SIGNAL, signal);
      }
      try {
        return (await handle.result()) as PlanningResult;
      } catch (err) {
        if (err instanceof WorkflowFailedError) return err;
        throw err;
      }
    });
  }

  const approve: Gate1DecisionSignal = { actorId: APPROVER, planVersion: 1, decision: 'approved' };

  it('auto-approves a plan wholly inside the SA and records auto=true', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ testCases: [testCase(), testCase({ class: 'passive' })] }]),
    });
    const r = (await run(h, [])) as PlanningResult;
    expect(r).toMatchObject({ outcome: 'approved', autoApproved: true, planVersion: 1 });
    expect(h.runs.state).toBe('approved');
    expect(h.decisions.rows[0]).toMatchObject({ auto: true });
    expect(h.envelopes.frozen).toHaveLength(1);
  });

  it('waits at Gate 1 for a human when a case is out of the SA, then freezes the envelope', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ testCases: [testCase(), testCase({ class: 'passive' })] }]),
      sas: new MemorySas(sa({ preApprovedTestClasses: ['active_safe'] })),
    });
    const r = (await run(h, [approve])) as PlanningResult;
    expect(r).toMatchObject({ outcome: 'approved', autoApproved: false });
    expect(h.decisions.rows[0]).toMatchObject({ auto: false, actorId: APPROVER });
    expect(h.plans.plans[0]?.frozen).toBe(true);
  });

  it('SoD: a decision by the requester is refused and the run keeps waiting for someone else', async () => {
    const h = makeHarness({
      sas: new MemorySas(sa({ preApprovedTestClasses: [] })),
      permissions: { canApprove: () => Promise.resolve(true) },
    });
    const r = (await run(h, [{ ...approve, actorId: REQUESTER }, approve])) as PlanningResult;
    expect(r.outcome).toBe('approved');
    expect(h.decisions.rows.map((d) => d.actorId)).toEqual([APPROVER]);
    expect(h.audit.records.some((x) => x.metadata.code === 'SOD_VIOLATION')).toBe(true);
  });

  it('a state_changing case blocks auto-approval even when the SA lists it', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ testCases: [testCase({ class: 'state_changing' })] }]),
      sas: new MemorySas(sa({ preApprovedTestClasses: ['active_safe', 'state_changing'] })),
    });
    const r = (await run(h, [approve])) as PlanningResult;
    expect(r).toMatchObject({ outcome: 'approved', autoApproved: false });
  });

  it('a destructive proposal is rejected at persistence and the planner gets one retry', async () => {
    const h = makeHarness({
      planner: new FakePlanner([
        { testCases: [testCase({ class: 'destructive' })] },
        { testCases: [testCase()] },
      ]),
    });
    const r = (await run(h, [])) as PlanningResult;
    expect(r.outcome).toBe('approved');
    expect(h.planner.requests).toHaveLength(2);
    expect(h.planner.requests[1]?.feedback).toContain('destructive');
    expect(h.plans.plans).toHaveLength(1);
    expect(h.plans.plans[0]?.testCases.every((c) => c.class !== 'destructive')).toBe(true);
  });

  it('still destructive after the retry: the run fails and nothing reaches Gate 1', async () => {
    const h = makeHarness({
      planner: new FakePlanner([{ testCases: [testCase({ class: 'destructive' })] }]),
    });
    expect(await run(h, [])).toBeInstanceOf(WorkflowFailedError);
    expect(h.planner.requests).toHaveLength(2);
    expect(h.plans.plans).toHaveLength(0);
    expect(h.runs.state).toBe('failed');
  });

  it('invalid output is retried once and then fails the run', async () => {
    const h = makeHarness({ planner: new FakePlanner([{ nope: 1 }]) });
    expect(await run(h, [])).toBeInstanceOf(WorkflowFailedError);
    expect(h.planner.requests).toHaveLength(2);
    expect(h.runs.state).toBe('failed');
  });

  it('an empty plan fails with PLAN_EMPTY without a retry', async () => {
    const h = makeHarness({ planner: new FakePlanner([{ testCases: [] }]) });
    const r = await run(h, []);
    expect(r).toBeInstanceOf(WorkflowFailedError);
    expect(h.planner.requests).toHaveLength(1);
    expect(h.runs.state).toBe('failed');
  });

  it('a rejection with re-plan asks the planner again and the new version is approved', async () => {
    const h = makeHarness({ sas: new MemorySas(sa({ preApprovedTestClasses: [] })) });
    const r = (await run(h, [
      {
        actorId: APPROVER,
        planVersion: 1,
        decision: 'rejected',
        next: 'replan',
        reason: 'too wide',
      },
      { actorId: APPROVER, planVersion: 2, decision: 'approved' },
    ])) as PlanningResult;
    expect(r).toMatchObject({ outcome: 'approved', rounds: 2, planVersion: 2 });
    expect(h.plans.plans.map((p) => p.status)).toEqual(['rejected', 'frozen']);
  });

  it('a rejection that cancels ends the run as cancelled', async () => {
    const h = makeHarness({ sas: new MemorySas(sa({ preApprovedTestClasses: [] })) });
    const r = (await run(h, [
      { actorId: APPROVER, planVersion: 1, decision: 'rejected', next: 'cancel', reason: 'no' },
    ])) as PlanningResult;
    expect(r.outcome).toBe('cancelled');
    expect(h.runs.state).toBe('cancelled');
  });

  it('Gate 1 timeout pages and never auto-approves; a later decision still completes', async () => {
    const h = makeHarness({ sas: new MemorySas(sa({ preApprovedTestClasses: [] })) });
    const r = (await run(h, [approve], {
      gate1TimeoutHours: 50 / 3_600_000,
      signalDelayMs: 1500,
    })) as PlanningResult;
    expect(r.gate1Pages).toBeGreaterThan(0);
    expect(h.pager.pages.length).toBeGreaterThan(0);
    expect(h.decisions.rows).toHaveLength(1);
    expect(h.decisions.rows[0]?.auto).toBe(false);
  });
});
