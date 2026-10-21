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
  DEFAULT_GATE3_PAGE_AFTER_MS,
  DEFAULT_VALIDATION_CONCURRENCY,
  GATE3_RELEASED_SIGNAL,
  POST_EXECUTION_PROGRESS_QUERY,
  type CandidateOutcome,
  type Gate3ReleaseSignal,
  type PostExecutionActivities,
  type PostExecutionInput,
  type PostExecutionProgress,
  type PostExecutionResult,
} from '../run/postexec/types.js';

const gate3Signal = defineSignal<[Gate3ReleaseSignal]>(GATE3_RELEASED_SIGNAL);
const progressQuery = defineQuery<PostExecutionProgress>(POST_EXECUTION_PROGRESS_QUERY);

// A validation replays in a fresh sandbox; VALIDATE owns the time it needs. A crash mid-replay is
// retried, and exhausted retries mean the candidate stays suspected (see below), never confirmed.
const validation = proxyActivities<PostExecutionActivities>({
  startToCloseTimeout: '15 minutes',
  retry: { initialInterval: '5 seconds', backoffCoefficient: 2, maximumAttempts: 3 },
});
const bookkeeping = proxyActivities<PostExecutionActivities>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumAttempts: 8 },
});
const writeUp = proxyActivities<PostExecutionActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { initialInterval: '10 seconds', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * ORCH-009: the post-execution phases `validating` -> `awaiting_gate3` -> `released` -> `reporting` ->
 * `completed`. Routes candidates to the Validator (judgement lives in VALIDATE), waits for a human
 * Gate 3 decision (never auto-releases; a long wait only pages), then runs the reporter and
 * remediation write-ups and completes the run only once the coverage manifest is finalised (F19).
 * A cancelled or killed run stops its validation sandboxes (ORCH-013).
 */
export async function PostExecutionWorkflow(
  input: PostExecutionInput,
): Promise<PostExecutionResult> {
  const ref = { tenantId: input.tenantId, runId: input.runId };
  const concurrency = Math.max(1, input.maxConcurrentValidations ?? DEFAULT_VALIDATION_CONCURRENCY);
  const pageAfterMs = input.gate3PageAfterMs ?? DEFAULT_GATE3_PAGE_AFTER_MS;

  const queue: Gate3ReleaseSignal[] = [];
  const progress = {
    phase: 'validating' as PostExecutionProgress['phase'],
    confirmed: 0,
    suspected: 0,
    undecided: 0,
    gate3Pages: 0,
  };
  setHandler(gate3Signal, (signal) => {
    queue.push(signal);
  });
  setHandler(progressQuery, () => ({ ...progress }));

  try {
    // validating
    const { candidateIds } = await bookkeeping.startValidation(ref);
    for (let i = 0; i < candidateIds.length; i += concurrency) {
      await Promise.all(
        candidateIds.slice(i, i + concurrency).map(async (findingId) => {
          let outcome: CandidateOutcome;
          try {
            outcome = await validation.validateCandidate({ ...ref, findingId });
          } catch (err) {
            if (isCancellation(err)) throw err;
            // The Validator could not answer after retries: fail closed to the analyst-only queue.
            outcome = { findingId, outcome: 'suspected', reason: 'VALIDATOR_UNAVAILABLE' };
          }
          await bookkeeping.recordOutcome({ ...ref, outcome });
          progress[outcome.outcome]++;
        }),
      );
    }

    // awaiting_gate3: only confirmed findings are offered; zero candidates still waits for a human.
    progress.undecided = (await bookkeeping.requestGate3(ref)).pending;
    progress.phase = 'awaiting_gate3';
    let decided = false;
    let released = 0;
    while (!decided) {
      if (!(await condition(() => queue.length > 0, pageAfterMs))) {
        progress.gate3Pages++;
        await bookkeeping.pageGate3Timeout({ ...ref, page: progress.gate3Pages });
        continue;
      }
      const signal = queue.shift();
      if (signal === undefined) continue;
      const verdict = await bookkeeping.decideGate3({ ...ref, signal });
      if (verdict.accepted) released += verdict.released;
      decided = verdict.accepted && verdict.allDecided;
    }
    progress.undecided = 0;

    // released -> reporting. A failed write-up never un-releases a finding.
    progress.phase = 'reporting';
    await bookkeeping.startReporting(ref);
    const writeUps = await Promise.allSettled([
      writeUp.runWriteUp({ ...ref, role: 'reporter' }),
      writeUp.runWriteUp({ ...ref, role: 'remediation' }),
    ]);
    const cancelled = writeUps.find((r) => r.status === 'rejected' && isCancellation(r.reason));
    if (cancelled?.status === 'rejected') throw cancelled.reason;
    if (writeUps.some((r) => r.status === 'rejected')) {
      throw ApplicationFailure.nonRetryable(
        'Reporter or remediation session failed after retries',
        'REPORTING_FAILED',
      );
    }
    await bookkeeping.finaliseCoverage(ref);
    const done = await bookkeeping.completeRun(ref);
    if (!done.completed) {
      throw ApplicationFailure.nonRetryable(
        'The coverage manifest is not finalised; the run cannot complete',
        done.code,
      );
    }
    progress.phase = 'completed';
    return {
      confirmed: progress.confirmed,
      suspected: progress.suspected,
      released,
      gate3Pages: progress.gate3Pages,
    };
  } catch (err) {
    if (isCancellation(err)) {
      await CancellationScope.nonCancellable(() => bookkeeping.abortValidation(ref));
    }
    throw err;
  }
}
