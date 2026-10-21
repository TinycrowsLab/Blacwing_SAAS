import { CancellationScope, proxyActivities } from '@temporalio/workflow';

import { decide, executePreflight } from '../run/preflight/aggregate.js';
import {
  DEFAULT_CHECK_ATTEMPTS,
  type PreflightActivities,
  type PreflightDecision,
  type PreflightWorkflowInput,
} from '../run/preflight/types.js';

const CHECK_TIMEOUT = '30 seconds';

/**
 * ORCH-003: the preflight phase. Runs the deterministic checks, persists the report and returns the
 * state-machine event for the run workflow to apply (`preflight_passed` -> recon, `sa_expired` -> expired,
 * `fail` -> failed with `statusReason`). Each check is its own activity, retried per check on transient
 * errors; definitive answers (asset unverified, SA expired, window closed) are values, never retried.
 */
export async function PreflightWorkflow(input: PreflightWorkflowInput): Promise<PreflightDecision> {
  const ref = { tenantId: input.tenantId, runId: input.runId };
  const acts = proxyActivities<PreflightActivities>({
    startToCloseTimeout: CHECK_TIMEOUT,
    retry: {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumAttempts: input.maxAttemptsPerCheck ?? DEFAULT_CHECK_ATTEMPTS,
    },
  });
  const started = Date.now();
  await acts.startPreflight(ref);

  // Cancels in-flight siblings once any check hard-fails.
  const scope = new CancellationScope();
  const report = await executePreflight(
    (id) => scope.run(() => acts[id](ref)),
    () => {
      scope.cancel();
    },
  );

  await acts.finishPreflight({ ...ref, report, durationMs: Date.now() - started });
  return decide(report);
}
