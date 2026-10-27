import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import {
  DEFAULT_GATE1_TIMEOUT_HOURS,
  GATE1_DECISION_SIGNAL,
  MAX_PLANNER_ATTEMPTS,
  MS_PER_HOUR,
  PLANNING_PROGRESS_QUERY,
  type Gate1DecisionSignal,
  type PlanningActivities,
  type PlanningInput,
  type PlanningProgress,
  type PlanningResult,
  type ProposeResult,
} from '../run/planning/types.js';

const gate1Signal = defineSignal<[Gate1DecisionSignal]>(GATE1_DECISION_SIGNAL);
const progressQuery = defineQuery<PlanningProgress>(PLANNING_PROGRESS_QUERY);

// A planner session is a `deep` model turn over the whole surface model. A crash is retried; a plan the
// planner cannot produce after the retries fails the run closed.
const planner = proxyActivities<PlanningActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { initialInterval: '5 seconds', backoffCoefficient: 2, maximumAttempts: 3 },
});
const bookkeeping = proxyActivities<PlanningActivities>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 8 },
});

const RUN_ENDED_STATES: ReadonlySet<string> = new Set(['killed', 'failed', 'expired']);

/** One planner round: a plan that fails validation is retried once, then the run fails closed. */
async function proposeWithRetry(
  runRef: { tenantId: string; runId: string },
  round: number,
): Promise<Extract<ProposeResult, { outcome: 'persisted' }>> {
  let feedback: string | undefined;
  for (let attempt = 1; ; attempt++) {
    const result = await planner.proposePlan({
      ...runRef,
      round,
      attempt,
      ...(feedback === undefined ? {} : { feedback }),
    });
    if (result.outcome === 'persisted') return result;
    // An empty plan is final: asking again would only repeat the question.
    if (result.code === 'PLAN_EMPTY' || attempt >= MAX_PLANNER_ATTEMPTS) {
      await bookkeeping.failPlanning({ ...runRef, code: result.code });
      throw ApplicationFailure.nonRetryable(
        `The planner produced no usable plan: ${result.code}`,
        result.code,
      );
    }
    feedback = result.detail;
  }
}

/**
 * ORCH-005: the `planning` phase and Gate 1. Runs the planner (structured output, one retry on a plan
 * that fails validation), persists the versioned plan, then either approves it under the standing
 * authorisation (every case inside it, never a `state_changing` one) or waits for a human Gate 1 decision
 * (never the requester, SoD). A long wait only pages: it never auto-approves. The run stays
 * `awaiting_gate1` while paged, because the state machine pauses only an `executing` run. Approval freezes the
 * approved run envelope; a rejection re-plans or cancels. A cancelled or killed run stops the planner
 * session (ORCH-013).
 */
export async function PlanningWorkflow(input: PlanningInput): Promise<PlanningResult> {
  const ref = { tenantId: input.tenantId, runId: input.runId };
  const timeoutMs = (input.gate1TimeoutHours ?? DEFAULT_GATE1_TIMEOUT_HOURS) * MS_PER_HOUR;

  const queue: Gate1DecisionSignal[] = [];
  const progress = { phase: 'planning' as PlanningProgress['phase'], round: 0, gate1Pages: 0 };
  setHandler(gate1Signal, (signal) => {
    queue.push(signal);
  });
  setHandler(progressQuery, () => ({ ...progress }));

  const done = (
    outcome: PlanningResult['outcome'],
    autoApproved: boolean,
    planVersion?: number,
  ): PlanningResult => ({
    outcome,
    rounds: progress.round,
    ...(planVersion === undefined ? {} : { planVersion }),
    autoApproved,
    gate1Pages: progress.gate1Pages,
  });

  try {
    for (;;) {
      progress.round++;
      progress.phase = 'planning';
      const plan = await proposeWithRetry(ref, progress.round);

      const requested = await bookkeeping.requestGate1({
        ...ref,
        planId: plan.planId,
        version: plan.version,
      });
      progress.phase = 'awaiting_gate1';
      if (
        (await bookkeeping.autoApprove({ ...ref, planId: plan.planId, version: plan.version }))
          .approved
      ) {
        progress.phase = 'approved';
        return done('approved', true, plan.version);
      }

      // Waiting for a human. Timeouts page and keep waiting; they never decide.
      let next: 'approved' | 'replan' | 'cancelled' | undefined;
      while (next === undefined) {
        if (!(await condition(() => queue.length > 0, timeoutMs))) {
          progress.gate1Pages++;
          await bookkeeping.pageGate1Timeout({ ...ref, page: progress.gate1Pages });
          continue;
        }
        const signal = queue.shift();
        if (signal === undefined) continue;
        const verdict = await bookkeeping.decideGate1({
          ...ref,
          signal,
          requestedAt: requested.requestedAt,
        });
        if (verdict.accepted) {
          next = verdict.outcome;
        } else if (verdict.code === 'GATE1_RUN_NOT_AWAITING') {
          // The run state is the truth: the first decision won, even if its reply was lost.
          next = followRunState(verdict.runState);
        } else if (verdict.terminal) {
          throw ApplicationFailure.nonRetryable(
            `Gate 1 ended the run: ${verdict.code}`,
            verdict.code,
          );
        }
      }
      if (next === 'approved') {
        progress.phase = 'approved';
        return done('approved', false, plan.version);
      }
      if (next === 'cancelled') {
        progress.phase = 'cancelled';
        return done('cancelled', false);
      }
      // 'replan': the run is back in `planning`; ask the planner for a new version.
    }
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => bookkeeping.abortPlanning(ref));
    }
    throw err;
  }
}

function followRunState(state: string | undefined): 'approved' | 'replan' | 'cancelled' {
  if (state === 'planning') return 'replan';
  if (state === 'cancelled') return 'cancelled';
  if (state === undefined || RUN_ENDED_STATES.has(state)) {
    throw ApplicationFailure.nonRetryable(
      `The run ended during Gate 1: ${state ?? 'unknown'}`,
      'RUN_ENDED',
    );
  }
  return 'approved';
}
