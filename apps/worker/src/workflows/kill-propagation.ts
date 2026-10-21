import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import { runKillPropagation } from '../kill/propagate.js';
import {
  EGRESS_DEADLINE_MS,
  KEY_DEADLINE_MS,
  SANDBOX_DEADLINE_MS,
  WORKFLOW_DEADLINE_MS,
  KILL_PROGRESS_QUERY,
  KILL_TARGETS_SIGNAL,
  type KillActivities,
  type KillLaterStage,
  type KillProgress,
  type KillPropagationRequest,
  type KillWorkflowInput,
} from '../kill/types.js';

const ACTIVITY_SLACK_MS = 3_000;

const targetsSignal = defineSignal<[KillPropagationRequest]>(KILL_TARGETS_SIGNAL);
const progressQuery = defineQuery<KillProgress>(KILL_PROGRESS_QUERY);

// The egress stage owns its 2 s deadline and retries inside the activity; Temporal's retry only covers
// a worker crash mid-stage, and every activity is idempotent (compare-and-set timestamps).
const acts = proxyActivities<KillActivities>({
  startToCloseTimeout: `${String(EGRESS_DEADLINE_MS + ACTIVITY_SLACK_MS)} milliseconds`,
  retry: { initialInterval: '100 milliseconds', backoffCoefficient: 2, maximumAttempts: 4 },
});

// Stage 2 may use the full (configurable) sandbox deadline; the 60 s cap bounds a mis-set env value.
const sandboxActs = proxyActivities<KillActivities>({
  startToCloseTimeout: `${String(SANDBOX_DEADLINE_MS + ACTIVITY_SLACK_MS * 2)} milliseconds`,
  retry: { initialInterval: '100 milliseconds', backoffCoefficient: 2, maximumAttempts: 2 },
});

const keyActs = proxyActivities<KillActivities>({
  startToCloseTimeout: `${String(KEY_DEADLINE_MS + ACTIVITY_SLACK_MS * 2)} milliseconds`,
  retry: { initialInterval: '100 milliseconds', backoffCoefficient: 2, maximumAttempts: 2 },
});

const workflowActs = proxyActivities<KillActivities>({
  startToCloseTimeout: `${String(WORKFLOW_DEADLINE_MS + ACTIVITY_SLACK_MS * 2)} milliseconds`,
  retry: { initialInterval: '100 milliseconds', backoffCoefficient: 2, maximumAttempts: 4 },
});

/** KILL-005: force-terminate the target sandboxes, then audit. An audit failure never blocks the kill. */
const sandboxStage: KillLaterStage = {
  name: 'sandbox',
  async run(request) {
    const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
    const result = await sandboxActs.terminateSandboxes({
      ...ref,
      sandboxIds: request.targets.sandboxIds,
    });
    try {
      await acts.auditSandboxesTerminated({ ...ref, result });
    } catch {
      // Retried by Temporal; if it still fails the kill goes on.
    }
  },
};

/** KILL-006 stage 3: revoke the virtual model keys, then audit. */
const keyStage: KillLaterStage = {
  name: 'keys',
  async run(request) {
    const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
    const result = await keyActs.revokeKeys({ ...ref, keyIds: request.targets.virtualKeyIds });
    try {
      await acts.auditKeysRevoked({ ...ref, result });
    } catch {
      // Retried by Temporal; if it still fails the kill goes on.
    }
  },
};

/** KILL-006 stage 4: cancel the run and session workflows, flag pending reversals, then audit. */
const workflowStage: KillLaterStage = {
  name: 'workflows',
  async run(request) {
    const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
    const result = await workflowActs.cancelWorkflows({
      ...ref,
      workflowIds: request.targets.workflowIds,
      runIds: request.targets.runIds,
    });
    try {
      await acts.auditWorkflowsCancelled({ ...ref, result });
    } catch {
      // Retried by Temporal; if it still fails the kill goes on.
    }
  },
};

/** The §8.5 order after egress: sandboxes terminated, then keys revoked, then workflows cancelled. */
const LATER_STAGES: readonly KillLaterStage[] = [sandboxStage, keyStage, workflowStage];

/**
 * KILL-004: executes one kill in the mandated order (egress block first). One workflow per kill event
 * (the workflow id derives from the event id). Re-signalling or re-running it for the same event is
 * safe: every activity is a compare-and-set, so nothing is blocked twice and no timestamp is reset.
 * `killProgress` is the reconciler query.
 */
export async function KillPropagationWorkflow(input: KillWorkflowInput): Promise<void> {
  let request: KillPropagationRequest | undefined;
  const progress: { current: KillProgress } = {
    current: { received: false, stage: 'waiting', egress: null, completed: false },
  };
  setHandler(targetsSignal, (signalled) => {
    // Only the first signal for this event counts; a retried enqueue is a no-op.
    if (request === undefined && signalled.killEventId === input.killEventId) {
      request = signalled;
      progress.current = { ...progress.current, received: true };
    }
  });
  setHandler(progressQuery, () => progress.current);

  await condition(() => request !== undefined);
  if (request === undefined) return;
  await runKillPropagation(request, acts, LATER_STAGES, progress);
}
