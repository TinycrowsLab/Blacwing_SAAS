import {
  FAILED_OUTCOMES,
  type ReconActivities,
  type ReconDecision,
  type ReconFailCode,
  type ReconRef,
  type ReconSessionInput,
  type ReconSessionOutcome,
  type ReconSessionRecord,
  type ReconSessionResult,
} from './types.js';

// Pure fan-out and join for the recon phase (ORCH-004). Bundled into the workflow, so no Node built-ins.
// The workflow supplies the Temporal pieces (child start, cancellation scope, activities); this decides.

interface ReconRunner {
  /** Starts one `AgentSessionWorkflow` child. Rejects when the child fails or is cancelled. */
  runChild(input: ReconSessionInput): Promise<ReconSessionResult>;
  /** Cancels every in-flight child (one shared cancellation scope). */
  cancelChildren(): void;
  isCancellation(error: unknown): boolean;
  started(input: ReconSessionInput): Promise<void>;
  finished(input: ReconSessionInput, outcome: ReconSessionOutcome, costUsd: number): Promise<void>;
}

interface ReconJoin {
  /** One record per dispatched persona, in manifest order. */
  readonly sessions: readonly ReconSessionRecord[];
  readonly costUsd: number;
  /** Set when the workflow itself was cancelled (kill, SA expiry); the caller rethrows it after cleanup. */
  readonly parentCancellation: { readonly error: unknown } | null;
}

/** Only a finite, non-negative spend counts; anything else is treated as no spend rather than poisoning the total. */
function spend(costUsd: number): number {
  return Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
}

/**
 * Runs every session in parallel and joins them like `Promise.allSettled`: one persona failing is
 * recorded and the others carry on. When the cumulative spend reaches `reconCostCapUsd` while
 * children are still running, the rest are cancelled and recorded as `cost_cap`.
 */
export async function runSessions(
  inputs: readonly ReconSessionInput[],
  reconCostCapUsd: number,
  runner: ReconRunner,
): Promise<ReconJoin> {
  const state = {
    cost: 0,
    running: inputs.length,
    capHit: false,
    parentCancellation: null as ReconJoin['parentCancellation'],
  };

  const runOne = async (input: ReconSessionInput): Promise<ReconSessionRecord> => {
    await runner.started(input);
    let outcome: ReconSessionOutcome;
    let costUsd = 0;
    try {
      const result = await runner.runChild(input);
      outcome = result.status;
      costUsd = spend(result.costUsd);
    } catch (error) {
      if (!runner.isCancellation(error)) {
        outcome = 'failed';
      } else if (state.capHit) {
        outcome = 'cost_cap';
      } else {
        outcome = 'cancelled';
        state.parentCancellation ??= { error };
      }
    }
    state.running -= 1;
    state.cost += costUsd;
    if (!state.capHit && state.running > 0 && state.cost >= reconCostCapUsd) {
      state.capHit = true;
      runner.cancelChildren();
    }
    await runner.finished(input, outcome, costUsd);
    return { persona: input.persona, sessionId: input.sessionId, outcome, costUsd };
  };

  const sessions = await Promise.all(inputs.map((input) => runOne(input)));
  return { sessions, costUsd: state.cost, parentCancellation: state.parentCancellation };
}

/** True when there was at least one persona and every one of them failed (crashed or errored). */
export function allFailed(sessions: readonly ReconSessionRecord[]): boolean {
  return sessions.length > 0 && sessions.every((s) => FAILED_OUTCOMES.includes(s.outcome));
}

/** The Temporal pieces the phase needs; the workflow supplies them, tests supply in-process doubles. */
export interface ReconPhaseEnv {
  readonly acts: ReconActivities;
  readonly runChild: ReconRunner['runChild'];
  readonly cancelChildren: ReconRunner['cancelChildren'];
  readonly isCancellation: ReconRunner['isCancellation'];
  readonly newSessionId: () => string;
  /** Epoch milliseconds the phase started at; a workflow cannot read the wall clock. */
  readonly startedAtMs: number;
  /** Runs `fn` outside any cancelled scope, so audit survives a kill. */
  readonly shield: <T>(fn: () => Promise<T>) => Promise<T>;
}

/**
 * The recon phase (ORCH-004). Resolve and dispatch the personas, join, then finalise the surface and
 * audit before returning the state-machine event. The event is returned only after `recon.completed` is
 * recorded. A cancellation (kill, SA expiry) records the abort and is rethrown.
 */
export async function executeRecon(ref: ReconRef, env: ReconPhaseEnv): Promise<ReconDecision> {
  const { acts } = env;
  let sessions: readonly ReconSessionRecord[] = [];

  const fail = (code: ReconFailCode, costUsd: number): ReconDecision => ({
    event: 'fail',
    statusReason: `recon_failed:${code}`,
    sessions,
    costUsd,
  });
  const finish = (
    outcome: 'completed' | 'failed' | 'cancelled',
    code?: ReconFailCode,
  ): Promise<void> =>
    env.shield(() =>
      acts.completeRecon({
        ...ref,
        outcome,
        ...(code === undefined ? {} : { code }),
        sessions,
        startedAtMs: env.startedAtMs,
      }),
    );

  try {
    const start = await acts.startRecon(ref);
    if (!start.ok) return fail(start.code, 0);

    const inputs = start.sessions.map((s): ReconSessionInput => ({
      ...s,
      sessionId: env.newSessionId(),
    }));
    const join = await runSessions(inputs, start.reconCostCapUsd, {
      runChild: env.runChild,
      cancelChildren: env.cancelChildren,
      isCancellation: env.isCancellation,
      started: (child) =>
        acts.recordSessionStarted({ ...ref, persona: child.persona, sessionId: child.sessionId }),
      finished: (child, outcome, costUsd) =>
        env.shield(() =>
          acts.recordSessionFinished({
            ...ref,
            persona: child.persona,
            sessionId: child.sessionId,
            mode: child.mode,
            outcome,
            costUsd,
          }),
        ),
    });
    sessions = join.sessions;

    if (join.parentCancellation !== null) throw join.parentCancellation.error;
    if (allFailed(sessions)) {
      await finish('failed', 'RECON_ALL_SESSIONS_FAILED');
      return fail('RECON_ALL_SESSIONS_FAILED', join.costUsd);
    }

    const surface = await acts.finaliseSurfaceModel(ref);
    if (!surface.ok) {
      await finish('failed', surface.code);
      return fail(surface.code, join.costUsd);
    }

    await finish('completed');
    return { event: 'recon_complete', statusReason: null, sessions, costUsd: join.costUsd };
  } catch (error) {
    if (env.isCancellation(error)) await finish('cancelled');
    throw error;
  }
}
