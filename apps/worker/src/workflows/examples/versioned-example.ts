// WORKFLOW-008 worked example: the v1 -> v2 change that docs/architecture/workflow-versioning.md prescribes.
// It is not a product workflow and is not re-exported from ../index.ts, so no worker registers it.
import { patched, proxyActivities } from '@temporalio/workflow';

/** Patch id for the v2 review step. Retire it with `deprecatePatch` once no v1 history is still open. */
const REVIEW_STEP_PATCH = 'versioned-example-review-step';

/** Activity names are part of the history. A signature change means a new name, never a mutation. */
export interface VersionedExampleActivities {
  planRun(runId: string): Promise<void>;
  recordReview(runId: string): Promise<void>;
  finishRun(runId: string): Promise<void>;
}

const acts = proxyActivities<VersionedExampleActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export interface VersionedExampleInput {
  readonly runId: string;
}

/**
 * v2: a review step between planning and finishing. The step is gated by `patched()`, which is called
 * unconditionally in code order. Histories that v1 started never recorded the marker, so `patched()` returns
 * false on replay and the v1 command sequence (plan, finish) is reproduced exactly.
 */
export async function versionedExampleWorkflow(input: VersionedExampleInput): Promise<void> {
  await acts.planRun(input.runId);
  if (patched(REVIEW_STEP_PATCH)) {
    await acts.recordReview(input.runId);
  }
  await acts.finishRun(input.runId);
}
