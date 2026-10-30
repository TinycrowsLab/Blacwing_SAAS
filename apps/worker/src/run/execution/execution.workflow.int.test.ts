// ORCH-008 (#232) integration: ExecutionWorkflow on a real Temporal worker with the real activities
// over in-memory ports (the agent runtime, dispatch layer and gates API are stubbed). Needs `pnpm dev:deps`
// (temporal + temporal-bootstrap). TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection, WorkflowFailedError, type WorkflowHandle } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExecutionActivities } from './activities.js';
import { temporalActivityRuntime } from './activity-context.js';
import {
  APPROVER,
  REF,
  REQUESTER,
  SCOPE_EXCEPTION,
  SINGLE_CALL,
  MemoryRunState,
  makeHarness,
  type Harness,
} from './testing.js';
import {
  EXECUTION_EVENT_SIGNAL,
  EXECUTION_PROGRESS_QUERY,
  EXECUTION_RESUMED_SIGNAL,
  EXECUTION_WORKFLOW,
  GATE2_DECIDED_SIGNAL,
  GATE2_EXCEPTION_DECISION_SIGNAL,
  GATE2_EXCEPTION_RAISED_SIGNAL,
  type ExecutionEvent,
  type ExecutionInput,
  type ExecutionProgress,
  type ExecutionResult,
  type Gate2DecidedSignal,
  type Gate2ExceptionDecisionSignal,
  type Gate2ExceptionRaisedSignal,
} from './types.js';

const EXCEPTION = '0190a000-0000-7000-8000-0000000000e1';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const POLL_MS = 50;
const FAST: Partial<ExecutionInput> = { pollMs: 100, stallPolls: 3 };

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleepMs(POLL_MS);
  }
}

describe('ExecutionWorkflow on Temporal', () => {
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

  function isDrained(c: {
    eligible: number;
    open: number;
    inFlight: number;
    awaitingGate2: number;
  }): boolean {
    return c.eligible + c.open + c.inFlight + c.awaitingGate2 === 0;
  }

  /** Sessions of an orchestrator that keeps working until the frontier is empty or it is interrupted. */
  function workingSessions(h: Harness): Harness['orchestrator']['script'] {
    return Array.from({ length: 50 }, () => async (_hooks, signal) => {
      while (!signal.aborted && !isDrained(await h.frontier.snapshot())) await sleepMs(POLL_MS);
      if (signal.aborted) throw new Error('interrupted');
      return 'end_turn' as const;
    });
  }

  function workingOrchestrator(h: Harness): void {
    h.orchestrator.script = workingSessions(h);
  }

  /** Starts the workflow on a fresh queue and hands the handle to `drive`; returns the result or failure. */
  async function run(
    h: Harness,
    drive: (handle: WorkflowHandle) => Promise<void>,
    input: Partial<ExecutionInput> = {},
  ): Promise<ExecutionResult | Error> {
    const taskQueue = `bw-exec-${randomUUID()}`;
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../../workflows/index.ts', import.meta.url)),
      activities: createExecutionActivities({
        ...h.deps,
        activity: temporalActivityRuntime,
        heartbeatMs: 200,
      }),
    });
    return worker.runUntil(async () => {
      const handle = await client.workflow.start(EXECUTION_WORKFLOW, {
        taskQueue,
        workflowId: `exec-${randomUUID()}`,
        args: [{ ...REF, ...FAST, ...input }],
      });
      await drive(handle);
      try {
        return (await handle.result()) as ExecutionResult;
      } catch (err) {
        if (err instanceof WorkflowFailedError) return err;
        throw err;
      }
    });
  }

  const progress = (h: WorkflowHandle): Promise<ExecutionProgress> =>
    h.query<ExecutionProgress>(EXECUTION_PROGRESS_QUERY);
  const event = (h: WorkflowHandle, e: ExecutionEvent): Promise<void> =>
    h.signal(EXECUTION_EVENT_SIGNAL, e);
  const decide = (
    h: WorkflowHandle,
    decisionId: string,
    actorId: string,
    decision: 'approved' | 'denied',
  ): Promise<void> =>
    h.signal(GATE2_DECIDED_SIGNAL, { decisionId, actorId, decision } satisfies Gate2DecidedSignal);

  const raised = (h: WorkflowHandle, exceptionId: string): Promise<void> =>
    h.signal(GATE2_EXCEPTION_RAISED_SIGNAL, {
      exceptionId,
    } satisfies Gate2ExceptionRaisedSignal);
  const decideException = (
    h: WorkflowHandle,
    exceptionId: string,
    actorId: string,
    decision: Gate2ExceptionDecisionSignal['decision'],
  ): Promise<void> =>
    h.signal(GATE2_EXCEPTION_DECISION_SIGNAL, {
      exceptionId,
      actorId,
      decision,
      reason: 'reviewed the call',
    } satisfies Gate2ExceptionDecisionSignal);

  it('starts the orchestrator and ends the phase when the frontier is empty (exec.frontier-drain)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async () => {
      await until(() => h.orchestrator.runs.length > 0, 'the orchestrator session');
      h.frontier.drain();
    });
    expect(result).toMatchObject({ terminalSubtasks: 2, recoveries: 0, mentorInterventions: 0 });
    expect(h.runs.state).toBe('validating');
    expect(h.audit.actions()).toEqual(
      expect.arrayContaining(['orchestrator.started', 'execution.completed']),
    );
    expect(h.orchestrator.stops.length).toBeGreaterThan(0);
  });

  it('completes straight away, without an orchestrator, when there is nothing to execute', async () => {
    const h = makeHarness();
    h.frontier.counts = { ...h.frontier.counts, eligible: 0, terminal: 3 };
    const result = await run(h, () => Promise.resolve());
    expect(result).toMatchObject({ terminalSubtasks: 3 });
    expect(h.orchestrator.started).toEqual([]);
    expect(h.runs.state).toBe('validating');
  });

  it('opens Gate 2 for a deferred call, resumes the session on approval and refuses the requester (exec.gate2-approve)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      h.frontier.counts = { ...h.frontier.counts, eligible: 0, awaitingGate2: 1 };
      await event(handle, SINGLE_CALL);
      await until(() => h.gates.rows.size === 1, 'the Gate 2 row');
      expect((await progress(handle)).gate2Pending).toBe(1);
      expect(h.gates.only().status).toBe('pending');
      expect(h.pager.pages).toHaveLength(1);

      await decide(handle, h.gates.only().decisionId, REQUESTER, 'approved');
      await until(() => h.audit.records.some((r) => r.outcome === 'failure'), 'the SoD refusal');
      expect(h.gates.only().status).toBe('pending');

      await decide(handle, h.gates.only().decisionId, APPROVER, 'approved');
      await until(() => h.branches.resumed.length === 1, 'the session resume');
      h.frontier.drain();
    });
    expect(result).toMatchObject({ gate2Opened: 1, gate2Approved: 1, gate2Denied: 0 });
    expect(h.branches.resumed[0]).toMatchObject({ toolUseId: 'tu-1', decision: 'approved' });
    expect(h.metrics.gate2Decisions).toEqual(['approved']);
  });

  it('denies a Gate 2 request nobody answers and resumes the session with deny (exec.gate2-timeout-deny)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(
      h,
      async (handle) => {
        h.frontier.counts = { ...h.frontier.counts, eligible: 0, awaitingGate2: 1 };
        await event(handle, SINGLE_CALL);
        await until(() => h.branches.resumed.length === 1, 'the denial');
        // An approval that arrives after the timeout cannot allow the call.
        await decide(handle, h.gates.only().decisionId, APPROVER, 'approved');
        await sleepMs(300);
        h.frontier.drain();
      },
      { gate2TimeoutMinutes: 0.01 },
    );
    expect(result).toMatchObject({ gate2Opened: 1, gate2Approved: 0, gate2Denied: 1 });
    expect(h.gates.only()).toMatchObject({ status: 'denied', auto: true, reason: 'GATE2_TIMEOUT' });
    expect(h.branches.resumed).toHaveLength(1);
    expect(h.branches.resumed[0]).toMatchObject({ decision: 'denied' });
    expect(h.metrics.gate2Decisions).toEqual(['timeout']);
  });

  it('denies a parallel-batch call with a reason and pauses the branch without opening Gate 2 (exec.parallel-batch-deny)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      await event(handle, { ...SINGLE_CALL, toolCallsInTurn: 2 });
      await until(() => h.branches.denied.length === 1, 'the denial');
      h.frontier.drain();
    });
    expect(result).toMatchObject({ gate2Opened: 0 });
    expect(h.branches.denied[0]?.reason).toContain('PARALLEL_BATCH');
    expect(h.branches.blocked).toEqual([{ subtaskId: 'st-1', reason: 'PARALLEL_BATCH_DENIED' }]);
    expect(h.gates.rows.size).toBe(0);
    expect(h.branches.resumed).toEqual([]);
  });

  it('opens Gate 2 for request_scope_exception and applies the approval to policy', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    await run(h, async (handle) => {
      await event(handle, SCOPE_EXCEPTION);
      await until(() => h.gates.rows.size === 1, 'the Gate 2 row');
      await decide(handle, h.gates.only().decisionId, APPROVER, 'approved');
      await until(() => h.scopeExceptions.resolved.length === 1, 'the policy update');
      h.frontier.drain();
    });
    expect(h.audit.actions()).toContain('scope_exception.requested');
    expect(h.scopeExceptions.resolved[0]).toMatchObject({
      target: SCOPE_EXCEPTION.target,
      decision: 'approved',
    });
  });

  it('spins a mentor on a stall, a reflector on repeated failure, then pauses for an operator (exec.mentor)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(
      h,
      async (handle) => {
        // The frontier never changes: no progress.
        await until(async () => (await progress(handle)).phase === 'paused', 'the operator pause');
        expect(h.advisors.runs.map((r) => r.role)).toEqual([
          'mentor',
          'mentor',
          'reflector',
          'mentor',
          'reflector',
        ]);
        expect(h.runs.facts.status).toMatchObject({ state: 'paused', reason: 'operator_pause' });
        expect(h.pager.pages.length).toBeGreaterThan(0);
        await handle.signal(EXECUTION_RESUMED_SIGNAL, { actorId: 'user-operator' });
        await until(() => h.runs.state === 'executing', 'the resume');
        h.frontier.drain();
      },
      { maxMentorInterventions: 3 },
    );
    expect(result).toMatchObject({ mentorInterventions: 0 });
    expect(h.runs.state).toBe('validating');
    expect(h.audit.records.filter((r) => r.action === 'mentor.requested')).toHaveLength(5);
  }, 180_000);

  it('resumes the orchestrator from its stored session after a crash (exec.resume-after-crash)', async () => {
    const h = makeHarness();
    h.orchestrator.script = [new Error('process exited'), ...workingSessions(h)];
    const result = await run(h, async () => {
      await until(() => h.orchestrator.runs.length >= 2, 'the resumed session');
      h.frontier.drain();
    });
    expect(result).toMatchObject({ recoveries: 1 });
    expect(new Set(h.orchestrator.runs)).toEqual(new Set(['sess-orch-1']));
    expect(h.orchestrator.started).toHaveLength(1);
    expect(h.runs.state).toBe('validating');
  }, 60_000);

  it('gives up after repeated crashes with a non-retryable failure', async () => {
    const h = makeHarness();
    h.orchestrator.script = Array.from({ length: 10 }, () => new Error('process exited'));
    const result = await run(h, () => Promise.resolve(), { maxOrchestratorRecoveries: 1 });
    expect(result).toBeInstanceOf(WorkflowFailedError);
    expect(h.runs.state).not.toBe('validating');
    expect(h.orchestrator.stops.length).toBeGreaterThan(0);
  }, 60_000);

  it('cancels the orchestrator and specialists and denies pending gates when the run is killed', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      await event(handle, SINGLE_CALL);
      await until(() => h.gates.rows.size === 1, 'the Gate 2 row');
      await handle.cancel();
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);
    expect(h.branches.cancelled).toBe(1);
    expect(h.gates.only()).toMatchObject({
      status: 'denied',
      auto: true,
      reason: 'GATE2_CANCELLED',
    });
    expect(h.orchestrator.stops.length).toBeGreaterThan(0);
    expect(h.runs.state).toBe('executing');
  });

  it('fails the phase when the run was killed underneath it', async () => {
    const h = makeHarness({ runs: new MemoryRunState('killed') });
    const result = await run(h, () => Promise.resolve());
    expect(result).toBeInstanceOf(WorkflowFailedError);
    expect(h.orchestrator.started).toEqual([]);
  });
  it('approves a broker-raised exception once when a different person decides in time (GATE2-004)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      h.gate2Exceptions.raise(EXCEPTION, 60_000);
      await raised(handle, EXCEPTION);
      await until(() => h.pager.pages.length === 1, 'the level 0 page');
      expect(h.gate2Exceptions.state(EXCEPTION)).toBe('pending');
      await decideException(handle, EXCEPTION, APPROVER, 'approve_once');
      await until(() => h.gate2Exceptions.state(EXCEPTION) === 'approved_once', 'the approval');
      // A duplicate decision after the first one is ignored, never applied.
      await decideException(handle, EXCEPTION, APPROVER, 'deny');
      h.frontier.drain();
    });
    expect(result).toMatchObject({ gate2Opened: 1, gate2Approved: 1, gate2Denied: 0 });
    expect(h.gate2Exceptions.applied).toEqual([
      { exceptionId: EXCEPTION, event: 'approve', actorId: APPROVER },
    ]);
    expect(h.metrics.gate2Decisions).toEqual(['approved']);
  });

  it('denies a broker-raised exception nobody decides before timeout_at, and a late approval cannot revive it (GATE2-004)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      h.gate2Exceptions.raise(EXCEPTION, 400);
      await raised(handle, EXCEPTION);
      await until(() => h.gate2Exceptions.state(EXCEPTION) === 'timed_out', 'the timeout');
      await decideException(handle, EXCEPTION, APPROVER, 'approve_once');
      await sleepMs(300);
      h.frontier.drain();
    });
    expect(result).toMatchObject({ gate2Opened: 1, gate2Approved: 0, gate2Denied: 1 });
    expect(h.gate2Exceptions.state(EXCEPTION)).toBe('timed_out');
    expect(h.gate2Exceptions.applied).toEqual([
      { exceptionId: EXCEPTION, event: 'time_out', actorId: 'gate2-timer' },
    ]);
    expect(h.metrics.gate2Decisions).toEqual(['timeout']);
  }, 60_000);

  it('refuses an approval by the requester and keeps the exception pending until an independent approver decides (GATE2-004)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    await run(h, async (handle) => {
      h.gate2Exceptions.raise(EXCEPTION, 60_000);
      await raised(handle, EXCEPTION);
      await decideException(handle, EXCEPTION, REQUESTER, 'approve_once');
      await sleepMs(300);
      expect(h.gate2Exceptions.state(EXCEPTION)).toBe('pending');
      await decideException(handle, EXCEPTION, APPROVER, 'approve_once');
      await until(() => h.gate2Exceptions.state(EXCEPTION) === 'approved_once', 'the approval');
      h.frontier.drain();
    });
    expect(h.gate2Exceptions.applied).toEqual([
      { exceptionId: EXCEPTION, event: 'approve', actorId: APPROVER },
    ]);
  });

  it('pages the escalation ladder at its offsets, and skips steps past the deadline (GATE2-004)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    await run(
      h,
      async (handle) => {
        h.gate2Exceptions.raise(EXCEPTION, 1500);
        await raised(handle, EXCEPTION);
        await until(() => h.metrics.escalations.length === 2, 'the escalation ladder');
        await until(() => h.gate2Exceptions.state(EXCEPTION) === 'timed_out', 'the timeout');
        h.frontier.drain();
      },
      { gate2EscalationSeconds: [0, 0.2, 5] },
    );
    // Level 2 is due at 5s, after the 1.5s deadline, so it never fires.
    expect(h.metrics.escalations).toEqual([0, 1]);
    expect(h.pager.pages).toHaveLength(2);
  }, 60_000);

  it('supersedes a pending exception and denies it when the run is killed during the wait (GATE2-004)', async () => {
    const h = makeHarness();
    workingOrchestrator(h);
    const result = await run(h, async (handle) => {
      h.gate2Exceptions.raise(EXCEPTION, 60_000);
      await raised(handle, EXCEPTION);
      await until(() => h.pager.pages.length === 1, 'the level 0 page');
      await handle.cancel();
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);
    expect(h.gate2Exceptions.state(EXCEPTION)).toBe('superseded');
    expect(h.gate2Exceptions.applied).toEqual([
      { exceptionId: EXCEPTION, event: 'supersede', actorId: 'gate2-exception-workflow' },
    ]);
  });
});
