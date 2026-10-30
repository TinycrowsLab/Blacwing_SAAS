import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  sleep,
  ChildWorkflowCancellationType,
} from '@temporalio/workflow';

import {
  AGENT_SESSION_WORKFLOW,
  type AgentSessionInput,
  type AgentSessionResult,
} from '../agent-session/types.js';
import {
  DISPATCH_SUBTASK_UPDATE,
  type DispatchActivities,
  type DispatchOutcome,
} from '../run/dispatch/types.js';
import {
  classifyOutOfEnvelope,
  INITIAL_STALL,
  isStalled,
  nextIntervention,
  observe,
} from '../run/execution/frontier.js';
import {
  DEFAULT_GATE2_ESCALATION_SECONDS,
  DEFAULT_GATE2_TIMEOUT_MINUTES,
  DEFAULT_MAX_MENTOR_INTERVENTIONS,
  DEFAULT_MAX_ORCHESTRATOR_RECOVERIES,
  DEFAULT_POLL_MS,
  DEFAULT_STALL_POLLS,
  EXECUTION_EVENT_SIGNAL,
  EXECUTION_PROGRESS_QUERY,
  EXECUTION_RESUMED_SIGNAL,
  GATE2_DECIDED_SIGNAL,
  GATE2_EXCEPTION_DECISION_SIGNAL,
  GATE2_EXCEPTION_RAISED_SIGNAL,
  type ExecutionActivities,
  type ExecutionEvent,
  type ExecutionInput,
  type ExecutionPauseReason,
  type ExecutionProgress,
  type ExecutionResult,
  type FrontierSnapshot,
  type Gate2DecidedSignal,
  type Gate2Decision,
  type Gate2ExceptionDecisionSignal,
  type Gate2ExceptionRaisedSignal,
  type Gate2ExceptionVerdict,
  type Gate2Request,
  type OrchestratorStopReason,
} from '../run/execution/types.js';

const eventSignal = defineSignal<[ExecutionEvent]>(EXECUTION_EVENT_SIGNAL);
const gate2Signal = defineSignal<[Gate2DecidedSignal]>(GATE2_DECIDED_SIGNAL);
const resumedSignal = defineSignal<[{ actorId: string }]>(EXECUTION_RESUMED_SIGNAL);
const gate2ExceptionRaisedSignal = defineSignal<[Gate2ExceptionRaisedSignal]>(
  GATE2_EXCEPTION_RAISED_SIGNAL,
);
const gate2ExceptionDecisionSignal = defineSignal<[Gate2ExceptionDecisionSignal]>(
  GATE2_EXCEPTION_DECISION_SIGNAL,
);
const dispatchUpdate = defineUpdate<DispatchOutcome, [unknown]>(DISPATCH_SUBTASK_UPDATE);
const progressQuery = defineQuery<ExecutionProgress>(EXECUTION_PROGRESS_QUERY);

const bookkeeping = proxyActivities<ExecutionActivities>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 8 },
});
const dispatchActs = proxyActivities<DispatchActivities>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 8 },
});
// Mentor and reflector sessions are short advisory runs; a failure is tolerated by the caller.
const advisory = proxyActivities<Pick<ExecutionActivities, 'requestMentor'>>({
  startToCloseTimeout: '30 minutes',
  retry: { initialInterval: '5 seconds', backoffCoefficient: 2, maximumAttempts: 3 },
});
// The orchestrator session is one long activity. It heartbeats; a missed heartbeat or a crash fails it
// and the workflow resumes the session from `sessionStore` itself, so Temporal must not retry blindly.
// Cancelling waits for the interrupt to complete, so a paused or finished phase never leaves it running.
const orchestratorRun = proxyActivities<Pick<ExecutionActivities, 'superviseOrchestrator'>>({
  startToCloseTimeout: '24 hours',
  heartbeatTimeout: '2 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 },
});

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;
const RECOVERY_BACKOFF_MS = 5000;

interface Supervision {
  readonly scope: CancellationScope;
  promise: Promise<void>;
  settled: boolean;
  stop: OrchestratorStopReason | null;
  crashed: boolean;
}

/**
 * ORCH-008: the `executing` phase. Starts the long-running orchestrator session and supervises it
 * until the subtask frontier is empty, then applies `validation_started`. Specialist dispatch is the
 * dispatch layer's (ORCH-007); this workflow reacts to what comes back as signals:
 *
 * - an out-of-envelope call from a specialist opens a Gate 2 decision (single call, `defer`), or is
 *   denied with a reason and its branch paused (parallel batch, where `defer` is ignored);
 * - `request_scope_exception` opens a Gate 2 decision the same way;
 * - no decision before `gate2TimeoutMinutes` means denied (F13), and an approval needs a different,
 *   authorised human (§8.4);
 * - a stall earns a mentor review (and a reflector after repeated failure), then an operator pause.
 *
 * Mentor and reflector sessions are advice only; no allow/deny ever depends on them (§8.11). A
 * cancelled, killed or failed phase stops the orchestrator and every specialist and denies pending gates.
 */
export async function ExecutionWorkflow(input: ExecutionInput): Promise<ExecutionResult> {
  const ref = { tenantId: input.tenantId, runId: input.runId };
  const gate2TimeoutMinutes = input.gate2TimeoutMinutes ?? DEFAULT_GATE2_TIMEOUT_MINUTES;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const stallPolls = input.stallPolls ?? DEFAULT_STALL_POLLS;
  const maxMentor = input.maxMentorInterventions ?? DEFAULT_MAX_MENTOR_INTERVENTIONS;
  const maxRecoveries = input.maxOrchestratorRecoveries ?? DEFAULT_MAX_ORCHESTRATOR_RECOVERIES;

  const state = {
    phase: 'starting' as ExecutionProgress['phase'],
    sessionId: null as string | null,
    snap: null as FrontierSnapshot | null,
    gate2Pending: 0,
    mentorInterventions: 0,
    recoveries: 0,
    gate2Opened: 0,
    gate2Approved: 0,
    gate2Denied: 0,
  };
  const handled = new Set<string>();
  const decisions: Gate2DecidedSignal[] = [];
  const resumes: { actorId: string }[] = [];
  const escalation = input.gate2EscalationSeconds ?? DEFAULT_GATE2_ESCALATION_SECONDS;
  // Broker-raised exceptions (GATE2-002): a signal for one already being waited on is a retry, not a new wait.
  const raisedExceptions = new Set<string>();
  const exceptionDecisions: Gate2ExceptionDecisionSignal[] = [];
  const branches = new Set<Promise<void>>();
  let branchesFinished = 0;
  let fatal: Error | null = null;
  let supervision: Supervision | null = null;

  setHandler(eventSignal, (event) => {
    const key = eventKey(event);
    if (handled.has(key)) return;
    handled.add(key);
    spawn(() => handleEvent(event));
  });
  setHandler(gate2Signal, (signal) => {
    decisions.push(signal);
  });
  setHandler(resumedSignal, (signal) => {
    resumes.push(signal);
  });
  setHandler(gate2ExceptionRaisedSignal, (signal) => {
    if (raisedExceptions.has(signal.exceptionId)) return;
    raisedExceptions.add(signal.exceptionId);
    spawn(() => gate2Exception(signal.exceptionId));
  });
  setHandler(gate2ExceptionDecisionSignal, (signal) => {
    exceptionDecisions.push(signal);
  });
  setHandler(progressQuery, () => ({
    phase: state.phase,
    sessionId: state.sessionId,
    openSubtasks: (state.snap?.open ?? 0) + (state.snap?.eligible ?? 0),
    inFlight: state.snap?.inFlight ?? 0,
    gate2Pending: state.gate2Pending,
    mentorInterventions: state.mentorInterventions,
    recoveries: state.recoveries,
  }));

  // The orchestrator's `dispatch_subtask` reaches the Run Controller here, never through an in-process
  // agent tool (§4.2, §8.2). The update answers at once so a refusal tells the orchestrator to back off;
  // the specialist runs as a child workflow with its own sandbox, egress identity, budget and kill handle.
  setHandler(dispatchUpdate, async (request) => {
    const outcome = await dispatchActs.planDispatch(ref, request);
    if (outcome.accepted && outcome.session !== null) {
      const session = outcome.session;
      spawn(() => runSpecialist(session, outcome.subtaskId));
    }
    return outcome;
  });

  /** Starts the specialist child (workflow id keyed by subtask: a repeat dispatch cannot start a second). */
  async function runSpecialist(session: AgentSessionInput, subtaskId: string): Promise<void> {
    await dispatchActs.markSubtaskRunning({ ...ref, subtaskId });
    let result: AgentSessionResult | null = null;
    let reason = 'session_workflow_failed';
    let cancelled: Error | null = null;
    try {
      result = (await executeChild(AGENT_SESSION_WORKFLOW, {
        workflowId: `agent-session-${subtaskId}`,
        args: [session],
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      })) as AgentSessionResult;
    } catch (err) {
      if (isCancellation(err)) {
        reason = 'cancelled';
        cancelled = err as Error;
      }
    }
    // The slot must be released and the result stored even when the phase is being cancelled.
    await CancellationScope.nonCancellable(() =>
      dispatchActs.recordSubtaskResult({
        ...ref,
        subtaskId,
        sessionId: result?.sessionId ?? null,
        sandboxId: result?.sandboxId ?? null,
        outcome: result?.subtask ?? { status: 'failed', reason, declined: false },
        costUsd: result?.totalCostUsd ?? 0,
      }),
    );
    if (cancelled !== null) throw cancelled;
  }

  /** Runs a branch beside the main loop; its failure is the phase's failure (fail closed). */
  function spawn(task: () => Promise<void>): void {
    const branch: Promise<void> = task()
      .catch((err: unknown) => {
        fatal ??= err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => {
        branches.delete(branch);
        branchesFinished++;
      });
    branches.add(branch);
  }

  function throwIfFatal(): void {
    if (fatal !== null) throw fatal;
  }

  async function handleEvent(event: ExecutionEvent): Promise<void> {
    switch (event.type) {
      case 'out_of_envelope_call':
        if (classifyOutOfEnvelope(event) === 'deny_and_pause') {
          await bookkeeping.denyAndPauseBranch({ ...ref, event });
          return;
        }
        await gate2({
          kind: 'tool_deferred',
          dedupeKey: `${event.sessionId}:${event.toolUseId}`,
          subtaskId: event.subtaskId,
          sessionId: event.sessionId,
          toolUseId: event.toolUseId,
          summary: `${event.toolName}: ${event.summary}`,
          target: null,
        });
        return;
      case 'scope_exception_requested':
        await gate2({
          kind: 'scope_exception',
          dedupeKey: `scope:${event.requestId}`,
          subtaskId: event.subtaskId,
          sessionId: null,
          toolUseId: null,
          summary: `${event.target}: ${event.reason}`,
          target: event.target,
        });
        return;
      case 'mentor_review_requested':
        await tolerate(() =>
          advisory.requestMentor({
            ...ref,
            reason: 'orchestrator_request',
            reflector: false,
            key: `request:${event.requestId}`,
          }),
        );
    }
  }

  /** Advice is optional: a failed advisory session never fails the phase. */
  async function tolerate(task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (err) {
      if (isCancellation(err)) throw err;
    }
  }

  /** Opens a Gate 2 decision, waits for a human or the timeout (denied), then applies the outcome. */
  async function gate2(request: Gate2Request): Promise<void> {
    state.gate2Pending++;
    try {
      const { decisionId } = await bookkeeping.openGate2({
        ...ref,
        request,
        timeoutMinutes: gate2TimeoutMinutes,
      });
      state.gate2Opened++;
      const decision = await awaitDecision(decisionId);
      await bookkeeping.applyGate2({ ...ref, decisionId });
      if (decision === 'approved') state.gate2Approved++;
      else state.gate2Denied++;
    } finally {
      state.gate2Pending--;
    }
  }

  /**
   * GATE2-004: waits on a broker-raised exception until a different, authorised person decides it or its
   * `timeout_at` passes. The deadline comes from the row and the database clock, never from the workflow's own
   * arithmetic on the signal's arrival. Escalation pages fire at the configured offsets meanwhile. A refused
   * decision (separation of duties, a stale decision) leaves the exception pending. Silence is `time_out`: denied.
   */
  async function gate2Exception(exceptionId: string): Promise<void> {
    const opened = await bookkeeping.readGate2Exception({ ...ref, exceptionId });
    if (opened?.state !== 'pending') return;
    state.gate2Pending++;
    state.gate2Opened++;
    const timers: CancellationScope[] = [];
    let expired = false;
    try {
      const timeoutMs = Math.max(0, Date.parse(opened.timeoutAt) - Date.parse(opened.now));
      const deadline = new CancellationScope();
      timers.push(deadline);
      void deadline
        .run(() => sleep(timeoutMs))
        .then(
          () => {
            expired = true;
          },
          () => undefined,
        );
      escalation.forEach((offsetSeconds, level) => {
        const offsetMs = offsetSeconds * MS_PER_SECOND;
        if (offsetMs >= timeoutMs) return;
        const step = new CancellationScope();
        timers.push(step);
        // A failed page is tolerated: escalation is advice and the deny default does not depend on it.
        void step
          .run(async () => {
            if (offsetMs > 0) await sleep(offsetMs);
            await bookkeeping.pageGate2Escalation({ ...ref, exceptionId, level });
          })
          .catch(() => undefined);
      });

      let verdict: Gate2ExceptionVerdict | null = null;
      for (;;) {
        await condition(
          () => expired || exceptionDecisions.some((d) => d.exceptionId === exceptionId),
        );
        const at = exceptionDecisions.findIndex((d) => d.exceptionId === exceptionId);
        if (at < 0) break;
        const [signal] = exceptionDecisions.splice(at, 1);
        if (signal === undefined) continue;
        const result = await bookkeeping.decideGate2Exception({
          ...ref,
          exceptionId,
          event: signal.decision === 'approve_once' ? 'approve' : 'deny',
          actor: { kind: 'user', id: signal.actorId },
          reason: signal.reason,
        });
        if (result.kind !== 'refused') {
          verdict = result;
          break;
        }
        // A person's refusal keeps the exception pending. A decision that found it already decided ends the wait.
        if (result.code === 'GATE2_ALREADY_DECIDED' || result.code === 'GATE2_NOT_FOUND') break;
      }

      // Nobody decided before the deadline (or the decided state was reached by someone else): record the timeout.
      verdict ??= await bookkeeping.decideGate2Exception({
        ...ref,
        exceptionId,
        event: 'time_out',
        actor: { kind: 'system', id: 'gate2-timer' },
      });
      if (verdict.kind !== 'refused' && verdict.state === 'approved_once') state.gate2Approved++;
      else state.gate2Denied++;
    } finally {
      for (const scope of timers) scope.cancel();
      state.gate2Pending--;
    }
  }

  async function awaitDecision(decisionId: string): Promise<Gate2Decision> {
    let expired = false;
    const timer = new CancellationScope();
    // A cancelled timer settles quietly; only the clock reaching zero denies.
    void timer
      .run(() => sleep(gate2TimeoutMinutes * MS_PER_MINUTE))
      .then(
        () => {
          expired = true;
        },
        () => undefined,
      );
    try {
      for (;;) {
        await condition(() => expired || decisions.some((d) => d.decisionId === decisionId));
        const at = decisions.findIndex((d) => d.decisionId === decisionId);
        if (at < 0) break;
        const [signal] = decisions.splice(at, 1);
        if (signal === undefined) continue;
        const verdict = await bookkeeping.decideGate2({
          ...ref,
          decisionId,
          resolution: {
            kind: 'human',
            actorId: signal.actorId,
            decision: signal.decision,
            ...(signal.reason === undefined ? {} : { reason: signal.reason }),
          },
        });
        // A refusal (same person as the requester, no permission) leaves the request open.
        if (verdict.accepted) return verdict.decision;
      }
    } finally {
      timer.cancel();
    }
    const verdict = await bookkeeping.decideGate2({
      ...ref,
      decisionId,
      resolution: { kind: 'timeout' },
    });
    return verdict.accepted ? verdict.decision : 'denied';
  }

  function startSupervision(sessionId: string): Supervision {
    const scope = new CancellationScope();
    const run: Supervision = {
      scope,
      promise: Promise.resolve(),
      settled: false,
      stop: null,
      crashed: false,
    };
    run.promise = scope
      .run(() => orchestratorRun.superviseOrchestrator({ ...ref, sessionId }))
      .then(
        (result) => {
          run.stop = result.stopReason;
          run.settled = true;
        },
        (err: unknown) => {
          run.crashed = !isCancellation(err);
          run.settled = true;
        },
      );
    return run;
  }

  /** Interrupts the orchestrator (if running) and makes sure no session of it is left behind. */
  async function haltSupervision(): Promise<void> {
    const run = supervision;
    supervision = null;
    if (run !== null) {
      if (!run.settled) run.scope.cancel();
      await run.promise;
    }
    await CancellationScope.nonCancellable(() => bookkeeping.stopOrchestrator(ref));
  }

  async function pauseUntilResumed(reason: ExecutionPauseReason): Promise<void> {
    await haltSupervision();
    await bookkeeping.pauseRun({ ...ref, reason });
    state.phase = 'paused';
    await condition(() => resumes.length > 0 || fatal !== null);
    throwIfFatal();
    const resumed = resumes.shift();
    if (resumed !== undefined) await bookkeeping.resumeRun({ ...ref, actorId: resumed.actorId });
    state.phase = 'running';
  }

  try {
    let snap = await bookkeeping.beginExecution(ref);
    state.snap = snap;
    state.phase = 'running';
    let stall = observe(INITIAL_STALL, snap.marker, false);
    // After the orchestrator ends its turn it is not restarted in a tight loop: it needs news (a changed
    // marker) or one quiet poll with work left to dispatch.
    let restart: { marker: string; ready: boolean } | null = null;

    for (;;) {
      throwIfFatal();
      if (snap.runTerminal) {
        throw ApplicationFailure.nonRetryable(
          'The run reached a terminal state during execution',
          'RUN_TERMINATED',
        );
      }

      if (snap.exhausted && branches.size === 0) {
        await haltSupervision();
        const done = await bookkeeping.completeExecution(ref);
        if (done.completed) break;
        // Work appeared between the last look and the transition: keep going.
        snap = await bookkeeping.observeFrontier(ref);
        state.snap = snap;
        continue;
      }

      if (
        supervision === null &&
        !snap.exhausted &&
        (restart === null || restart.ready || restart.marker !== snap.marker)
      ) {
        restart = null;
        state.sessionId ??= (await bookkeeping.startOrchestrator(ref)).sessionId;
        supervision = startSupervision(state.sessionId);
      }

      const seenFinished = branchesFinished;
      const woke = await condition(
        () => supervision?.settled === true || branchesFinished !== seenFinished || fatal !== null,
        pollMs,
      );
      throwIfFatal();

      let orchestratorStopped = false;
      let endedTurn = false;
      if (supervision?.settled === true) {
        const stopped = supervision;
        supervision = null;
        orchestratorStopped = true;
        if (stopped.crashed) {
          state.recoveries++;
          if (state.recoveries > maxRecoveries) {
            throw ApplicationFailure.nonRetryable(
              'The orchestrator session kept crashing',
              'ORCHESTRATOR_UNRECOVERABLE',
            );
          }
          // Make sure the crashed session is gone, then resume it from `sessionStore` on the next turn.
          await CancellationScope.nonCancellable(() => bookkeeping.stopOrchestrator(ref));
          await sleep(RECOVERY_BACKOFF_MS * state.recoveries);
        } else if (stopped.stop === 'budget_exhausted') {
          await pauseUntilResumed('cost_cap');
        } else {
          endedTurn = true;
        }
      }

      snap = await bookkeeping.observeFrontier(ref);
      state.snap = snap;
      if (endedTurn) restart = { marker: snap.marker, ready: false };
      else if (restart !== null && !woke) restart.ready = snap.open + snap.eligible > 0;
      // Only a wait that ended without news counts: a poll timing out, or the orchestrator stopping.
      stall = observe(stall, snap.marker, (!woke || orchestratorStopped) && branches.size === 0);
      if (!snap.exhausted && isStalled(stall, stallPolls)) {
        const next = nextIntervention(state.mentorInterventions, maxMentor);
        if (next.kind === 'pause') {
          await pauseUntilResumed('operator_pause');
          state.mentorInterventions = 0;
        } else {
          state.mentorInterventions++;
          await tolerate(() =>
            advisory.requestMentor({
              ...ref,
              reason: 'stall',
              reflector: next.reflector,
              key: `stall-${state.mentorInterventions}`,
            }),
          );
        }
        stall = { marker: snap.marker, ticks: 0 };
      }
    }

    state.phase = 'completed';
    return {
      mentorInterventions: state.mentorInterventions,
      recoveries: state.recoveries,
      gate2Opened: state.gate2Opened,
      gate2Approved: state.gate2Approved,
      gate2Denied: state.gate2Denied,
      terminalSubtasks: snap.terminal,
    };
  } catch (err) {
    // Cancelled, killed or failed: nothing may keep running or stay approvable (ORCH-013).
    await CancellationScope.nonCancellable(async () => {
      await haltSupervision();
      await bookkeeping.abortExecution(ref);
      // A killed or cancelled run leaves no Gate 2 exception approvable: pending ones are superseded (deny).
      await bookkeeping.supersedeGate2Exceptions(ref);
    });
    throw err;
  }
}

function eventKey(event: ExecutionEvent): string {
  switch (event.type) {
    case 'out_of_envelope_call':
      return `call:${event.sessionId}:${event.toolUseId}`;
    case 'scope_exception_requested':
      return `scope:${event.requestId}`;
    case 'mentor_review_requested':
      return `mentor:${event.requestId}`;
  }
}
