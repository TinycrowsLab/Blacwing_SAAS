// Negative control for versioned-example.ts (WORKFLOW-008). The same review step, inserted WITHOUT patched().
// The replay test proves this breaks a v1 history, so the guarded version is the only safe rollout.
import { proxyActivities } from '@temporalio/workflow';

import type { VersionedExampleActivities, VersionedExampleInput } from './versioned-example.js';

const acts = proxyActivities<VersionedExampleActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

export async function versionedExampleWorkflow(input: VersionedExampleInput): Promise<void> {
  await acts.planRun(input.runId);
  await acts.recordReview(input.runId);
  await acts.finishRun(input.runId);
}
