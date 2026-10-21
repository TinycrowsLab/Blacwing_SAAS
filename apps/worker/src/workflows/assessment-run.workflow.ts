import {
  ActivityFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  log,
  metricMeter,
  proxyActivities,
  setHandler,
  upsertSearchAttributes,
  workflowInfo,
} from '@temporalio/workflow';

import {
  type RunBudgetRemaining,
  type RunInput,
  type RunStateView,
  type RunSummary,
  gate1DecisionSignalSchema,
  gate2DecisionSignalSchema,
  gate3ReleasedSignalSchema,
  increaseBudgetSignalSchema,
  killSignalSchema,
  pauseSignalSchema,
  resumeSignalSchema,
  raiseRunBudget,
  runInputSchema,
  RUN_QUERIES,
  RUN_SIGNALS,
  systemSignalSchema,
} from '@blackwing/contracts/run-workflow';
import {
  applyTransition,
  describeTransition,
  isTerminal,
  RUN_TRANSITIONS_METRIC,
  transitions,
  type RunActor,
  type RunEvent,
  type RunStatus,
} from '@blackwing/domain/run';

import { CONTROL_ACTIVITY_OPTIONS, PHASE_ACTIVITY_OPTIONS } from '../activities/run/options.js';

import type {
  PhaseResult,
  RunControlActivities,
  RunPhaseActivities,
  RunRef,
} from '../activities/run/types.js';
import type { ZodType } from 'zod';

const SYSTEM: RunActor = Object.freeze({ kind: 'system', id: 'system' });

/** Re-read attempts after `state_version` conflicts for one event before the event is dropped. */
const MAX_CONFLICT_RETRIES = 5;
const MS_PER_SECOND = 1000;
/** Sorts after every prioritised event type. */
const NORMAL_PRIORITY = 9;

const control = proxyActivities<RunControlActivities>(CONTROL_ACTIVITY_OPTIONS);
const preflight = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runPreflight);
const recon = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runRecon);
const planning = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runPlanning);
const execution = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runExecution);
const validation = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runValidation);
const reporting = proxyActivities<RunPhaseActivities>(PHASE_ACTIVITY_OPTIONS.runReporting);

const transitionsTotal = metricMeter.createCounter(
  RUN_TRANSITIONS_METRIC,
  undefined,
  'Accepted run state transitions',
);
const phaseDuration = metricMeter.createHistogram(
  'blackwing_run_phase_duration_seconds',
  'float',
  'seconds',
  'Time a run spent in a phase',
);
const runActive = metricMeter.createGauge(
  'blackwing_run_active',
  'int',
  undefined,
  '1 while a run controller is live',
);

/** A signal after validation, ready for the state machine. */
interface QueuedEvent {
  readonly event: RunEvent;
  readonly actor: RunActor;
  /** Guard facts that only a signal can supply. */
  readonly autoApproved?: boolean;
}

/** Events that stop work in flight: the phase activity is cancelled so no more traffic is sent (§8.5). */
const INTERRUPTING: ReadonlySet<RunEvent['type']> = new Set([
  'kill',
  'sa_expired',
  'window_closed',
  'pause',
]);

/** True when `type` would be accepted in `state` (the table, not a guess). */
function isLegal(state: RunStatus['state'], type: RunEvent['type']): boolean {
  return Object.hasOwn(transitions[state], type);
}

/** Kill beats everything else queued (§8.5); the rest keep arrival order. */
const PRIORITY: Partial<Record<RunEvent['type'], number>> = { kill: 0, sa_expired: 1 };

function viewOf(status: RunStatus): RunStateView {
  return {
    state: status.state,
    version: status.version,
    pauseReason: status.state === 'paused' ? status.reason : null,
  };
}

function statusOf(view: RunStateView): RunStatus {
  if (view.state === 'paused') {
    // `paused` always resumes to `executing`; a paused row without a reason is stale data, fail safe.
    return {
      state: 'paused',
      reason: view.pauseReason ?? 'operator_pause',
      resumeTo: 'executing',
      version: view.version,
    };
  }
  return { state: view.state, version: view.version };
}

/** The phase being worked: a paused run is still in the phase it will resume to. */
function phaseOf(status: RunStatus): RunStatus['state'] {
  return status.state === 'paused' ? status.resumeTo : status.state;
}

/**
 * ORCH-002: the Run Controller (CONTEXT_PACK §4.2). Deterministic: no I/O, no randomness and no wall
 * clock reads (the start time comes from `workflowInfo()`, persist times from activity results). Every
 * state change goes through
 * `applyTransition`, is persisted by `persistRunState` with optimistic concurrency, and is audited by
 * `writeAudit`. Only signals and activity results move the run, never model output (§8.11).
 *
 * Phase bodies are activities filled in by later issues; here each returns `ok`/`failed`. Signals are
 * validated and queued; the loop applies them in order (kill first), so a duplicate or illegal signal is
 * logged and dropped rather than crashing the workflow.
 */
export async function AssessmentRunWorkflow(rawInput: RunInput): Promise<RunStateView> {
  const input = runInputSchema.parse(rawInput);
  const ref: RunRef = { tenantId: input.tenantId, runId: input.runId };
  const logBase = { runId: input.runId, tenantId: input.tenantId };

  let status: RunStatus = { state: 'draft', version: 0 };
  let budgets: RunBudgetRemaining = { ...input.budgets };
  const queue: QueuedEvent[] = [];
  const releasedFindingIds: string[] = [];
  /** Finding ids of a Gate 3 signal, committed only if its transition is accepted. */
  const pendingRelease: string[] = [];
  const gate2Decisions = new Map<string, 'approved' | 'denied'>();
  let ignoredSignals = 0;
  let failureReason: string | null = null;
  let phaseStartedAt = workflowInfo().startTime.getTime();

  const ignore = (why: string, extra: Record<string, unknown> = {}): void => {
    ignoredSignals += 1;
    log.warn('run signal ignored', { ...logBase, phase: phaseOf(status), reason: why, ...extra });
  };

  /** Validates a payload; an invalid one is logged and dropped (fail closed, never throws). */
  const parse = <T>(schema: ZodType<T>, name: string, payload: unknown): T | null => {
    if (isTerminal(status.state)) {
      ignore('terminal', { signal: name });
      return null;
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      ignore('invalid_payload', { signal: name });
      return null;
    }
    return parsed.data;
  };

  const enqueue = (event: RunEvent, actor: RunActor, autoApproved?: boolean): void => {
    queue.push({ event, actor, ...(autoApproved === undefined ? {} : { autoApproved }) });
  };

  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.pause), (payload) => {
    const p = parse(pauseSignalSchema, RUN_SIGNALS.pause, payload);
    if (p !== null) enqueue({ type: 'pause', reason: p.reason }, p.actor);
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.resume), (payload) => {
    const p = parse(resumeSignalSchema, RUN_SIGNALS.resume, payload);
    if (p !== null) enqueue({ type: 'resume' }, p.actor);
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.gate1Decision), (payload) => {
    const p = parse(gate1DecisionSignalSchema, RUN_SIGNALS.gate1Decision, payload);
    if (p === null) return;
    enqueue(
      { type: p.decision === 'approved' ? 'gate1_approved' : 'gate1_rejected' },
      p.actor,
      p.autoApproved,
    );
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.gate2Decision), (payload) => {
    const p = parse(gate2DecisionSignalSchema, RUN_SIGNALS.gate2Decision, payload);
    if (p === null) return;
    // A person decides; the first decision for a subtask stands (duplicate delivery is a no-op).
    if (p.actor.kind !== 'user' || gate2Decisions.has(p.subtaskId)) {
      ignore('gate2_not_applicable', { signal: RUN_SIGNALS.gate2Decision });
      return;
    }
    gate2Decisions.set(p.subtaskId, p.decision);
    // Approval releases a run paused on exactly this gate; a denial leaves it paused (denied by default).
    if (
      p.decision === 'approved' &&
      status.state === 'paused' &&
      status.reason === 'gate2_pending'
    ) {
      enqueue({ type: 'resume' }, p.actor);
    }
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.gate3Released), (payload) => {
    const p = parse(gate3ReleasedSignalSchema, RUN_SIGNALS.gate3Released, payload);
    if (p === null) return;
    enqueue({ type: 'gate3_released' }, p.actor);
    pendingRelease.push(...p.findingIds);
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.increaseBudget), (payload) => {
    const p = parse(increaseBudgetSignalSchema, RUN_SIGNALS.increaseBudget, payload);
    if (p === null) return;
    if (p.actor.kind !== 'user') {
      ignore('budget_needs_a_person', { signal: RUN_SIGNALS.increaseBudget });
      return;
    }
    const raised = raiseRunBudget(budgets, p.delta);
    // Over a platform ceiling: refuse the whole increase rather than clamp silently.
    if (raised === null) {
      ignore('budget_over_ceiling', { signal: RUN_SIGNALS.increaseBudget });
      return;
    }
    budgets = raised;
    log.info('run budget increased', { ...logBase, phase: phaseOf(status) });
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.kill), (payload) => {
    // Scope (run/asset/tenant/global) only says why the coordinator sent it: this run stops either way.
    const p = parse(killSignalSchema, RUN_SIGNALS.kill, payload);
    if (p !== null) enqueue({ type: 'kill' }, p.actor);
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.saExpired), (payload) => {
    const p = parse(systemSignalSchema, RUN_SIGNALS.saExpired, payload);
    if (p !== null) enqueue({ type: 'sa_expired' }, p.actor);
  });
  setHandler(defineSignal<[unknown]>(RUN_SIGNALS.windowClosed), (payload) => {
    const p = parse(systemSignalSchema, RUN_SIGNALS.windowClosed, payload);
    if (p !== null) enqueue({ type: 'window_closed' }, p.actor);
  });

  // Spend is metered by the egress and model gateways (EGRESS-010, GATEWAY-011), which pause the run
  // with `cost_cap`; until consumption is reported here, "remaining" is the effective budget.
  const remaining = (): RunBudgetRemaining => ({ ...budgets });
  const summary = (): RunSummary => ({
    runId: input.runId,
    tenantId: input.tenantId,
    mode: input.mode,
    ...viewOf(status),
    phase: phaseOf(status),
    budgetRemaining: remaining(),
    openSubtasks: [],
    releasedFindingIds: [...releasedFindingIds],
    ignoredSignals,
    failureReason,
  });
  setHandler(defineQuery<RunStateView>(RUN_QUERIES.getState), () => viewOf(status));
  setHandler(defineQuery<string>(RUN_QUERIES.getPhase), () => phaseOf(status));
  setHandler(defineQuery<RunBudgetRemaining>(RUN_QUERIES.getBudgetRemaining), remaining);
  setHandler(defineQuery<string[]>(RUN_QUERIES.getOpenSubtasks), () => []);
  setHandler(defineQuery<RunSummary>(RUN_QUERIES.getSummary), summary);

  const preemptPending = (): boolean =>
    queue.some((q) => (PRIORITY[q.event.type] ?? NORMAL_PRIORITY) < NORMAL_PRIORITY);

  /**
   * Applies one event: state machine, optimistic persist, audit. Returns true when the run moved.
   * A refusal by the state machine (illegal, or a guard) is logged and dropped. A `state_version`
   * conflict re-reads the row the activity returned and tries again, stopping if it is terminal.
   */
  const process = async (item: QueuedEvent, detail?: string): Promise<boolean> => {
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
      if (isTerminal(status.state)) {
        ignore('terminal', { eventType: item.event.type });
        return false;
      }
      let result;
      try {
        const envelopeValid =
          item.event.type === 'execution_started' || item.event.type === 'resume'
            ? await control.verifyEnvelope({ ...ref, saId: input.saId })
            : undefined;
        // A kill or expiry that landed during the check wins (§8.5): do not start or resume work.
        if (envelopeValid !== undefined && preemptPending()) {
          ignore('preempted', { eventType: item.event.type });
          return false;
        }
        result = applyTransition(status, item.event, {
          actor: item.actor,
          requestedBy: input.requestedBy,
          ...(item.autoApproved === undefined ? {} : { autoApproved: item.autoApproved }),
          ...(envelopeValid === undefined ? {} : { envelopeValid }),
        });
      } catch (err) {
        if (err instanceof ActivityFailure) throw err;
        ignore('refused', {
          eventType: item.event.type,
          error: err instanceof Error ? err.name : 'unknown',
        });
        return false;
      }
      // Documented idempotent no-op (e.g. a duplicate pause or kill): nothing to persist or audit.
      if (result.auditIntent === null) return false;

      const { next, auditIntent } = result;
      const saved = await control.persistRunState({
        ...ref,
        from: status.state,
        to: next.state,
        pauseReason: next.state === 'paused' ? next.reason : null,
        expectedVersion: status.version,
      });
      if (saved.outcome === 'conflict') {
        // A concurrent API write moved the row: adopt it, then re-evaluate the event against it.
        log.warn('run state_version conflict, reconciling', {
          ...logBase,
          phase: phaseOf(status),
          eventType: item.event.type,
          attempt,
        });
        status = statusOf(saved.current);
        continue;
      }

      const durationSeconds = (saved.persistedAtMs - phaseStartedAt) / MS_PER_SECOND;
      phaseDuration.record(durationSeconds, { phase: phaseOf(status) });
      transitionsTotal.add(1, { from: auditIntent.from, to: auditIntent.to });
      status = { ...next, version: saved.version };
      phaseStartedAt = saved.persistedAtMs;
      upsertSearchAttributes({ runState: [status.state] });
      log.info('run transition', {
        ...logBase,
        phase: phaseOf(status),
        ...describeTransition(input.runId, auditIntent),
      });
      await control.writeAudit({
        ...ref,
        intent: auditIntent,
        actor: item.actor,
        ...(detail === undefined ? {} : { detail }),
      });
      return true;
    }
    ignore('conflict_retries_exhausted', { eventType: item.event.type });
    return false;
  };

  /** Applies everything queued, kill first. Gate 3 finding ids are kept only when the release applied. */
  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      let best = 0;
      for (let i = 1; i < queue.length; i += 1) {
        if (
          (PRIORITY[queue[i]?.event.type ?? 'fail'] ?? NORMAL_PRIORITY) <
          (PRIORITY[queue[best]?.event.type ?? 'fail'] ?? NORMAL_PRIORITY)
        )
          best = i;
      }
      const [item] = queue.splice(best, 1);
      if (item === undefined) break;
      const moved = await process(item);
      if (item.event.type === 'gate3_released') {
        if (moved) releasedFindingIds.push(...pendingRelease);
        pendingRelease.length = 0;
      }
    }
  };

  /** Runs `body` unless an interrupting signal arrives first, in which case it is cancelled. */
  const interruptible = async <T>(body: () => Promise<T>): Promise<T | 'interrupted'> => {
    const interrupting = (): boolean =>
      queue.some((q) => INTERRUPTING.has(q.event.type) && isLegal(status.state, q.event.type));
    const scope = new CancellationScope({ cancellable: true });
    const waitScope = new CancellationScope({ cancellable: true });
    const work = scope.run(body).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const interrupted = waitScope
      .run(() => condition(interrupting))
      .then(
        () => 'interrupted' as const,
        () => 'stopped' as const,
      );
    const first = await Promise.race([work, interrupted]);
    waitScope.cancel();
    if (first === 'interrupted') {
      scope.cancel();
      await work;
      return 'interrupted';
    }
    if (first === 'stopped') throw new Error('interrupt watcher stopped early');
    if ('error' in first) throw first.error;
    return first.value;
  };

  const failRun = async (reason: string): Promise<void> => {
    failureReason = reason;
    log.error('run failed', { ...logBase, phase: phaseOf(status), reason });
    await process({ event: { type: 'fail' }, actor: SYSTEM }, reason);
  };

  /** The phase body for the current state, or `null` when the state waits for a signal. */
  const phaseBody = (
    state: RunStatus['state'],
  ): { run: () => Promise<PhaseResult>; done: RunEvent } | null => {
    switch (state) {
      case 'preflight':
        return { run: () => preflight.runPreflight(ref), done: { type: 'preflight_passed' } };
      case 'recon':
        return { run: () => recon.runRecon(ref), done: { type: 'recon_complete' } };
      case 'planning':
        return { run: () => planning.runPlanning(ref), done: { type: 'plan_proposed' } };
      case 'executing':
        return { run: () => execution.runExecution(ref), done: { type: 'validation_started' } };
      case 'validating':
        return { run: () => validation.runValidation(ref), done: { type: 'gate3_requested' } };
      case 'reporting':
        return { run: () => reporting.runReporting(ref), done: { type: 'completed' } };
      default:
        return null;
    }
  };

  /** Events the controller itself raises on entering a state that has no body. */
  const automatic = (state: RunStatus['state']): RunEvent | null => {
    switch (state) {
      case 'draft':
        return { type: 'preflight_started' };
      case 'approved':
        return { type: 'execution_started' };
      case 'released':
        return { type: 'reporting_started' };
      default:
        return null;
    }
  };

  upsertSearchAttributes({ runState: [status.state] });
  runActive.set(1, { tenant: input.tenantId });
  log.info('run controller started', { ...logBase, phase: status.state });
  try {
    while (!isTerminal(status.state)) {
      await drain();
      if (isTerminal(status.state)) break;

      const auto = automatic(status.state);
      if (auto !== null) {
        const before = status.version;
        const moved = await process({ event: auto, actor: SYSTEM });
        if (!moved && status.version === before && !isTerminal(status.state) && !preemptPending()) {
          // The controller's own step was refused (e.g. no valid envelope): stop, never spin (fail closed).
          await failRun(`controller step ${auto.type} refused in ${status.state}`);
        }
        continue;
      }

      const body = phaseBody(status.state);
      if (body === null) {
        // Waiting on a gate or a resume: nothing to run until a signal arrives.
        await condition(() => queue.length > 0);
        continue;
      }
      const outcome = await interruptible(body.run);
      if (outcome === 'interrupted') continue;
      if (outcome.outcome === 'failed') {
        await failRun(outcome.reason);
        continue;
      }
      // A signal that arrived while the phase finished wins: re-evaluate before advancing.
      if (
        queue.some((q) => INTERRUPTING.has(q.event.type) && isLegal(status.state, q.event.type))
      ) {
        continue;
      }
      const before = status.version;
      const moved = await process({ event: body.done, actor: SYSTEM });
      if (!moved && status.version === before && !isTerminal(status.state) && !preemptPending()) {
        await failRun(`controller step ${body.done.type} refused in ${status.state}`);
      }
    }
  } catch (err) {
    // An activity exhausted its retries: stop the run with a reason (ORCH-002 edge cases).
    if (!(err instanceof ActivityFailure) || isTerminal(status.state)) throw err;
    await failRun(`activity ${err.activityType} failed after retries`);
  } finally {
    runActive.set(0, { tenant: input.tenantId });
  }
  log.info('run controller finished', { ...logBase, phase: status.state });
  return viewOf(status);
}
