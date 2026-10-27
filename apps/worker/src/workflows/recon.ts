import {
  CancellationScope,
  ChildWorkflowCancellationType,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  uuid4,
  workflowInfo,
} from '@temporalio/workflow';

import { executeRecon } from '../run/recon/orchestrate.js';
import {
  AGENT_SESSION_WORKFLOW,
  DEFAULT_RECON_ATTEMPTS,
  type ReconActivities,
  type ReconDecision,
  type ReconSessionResult,
  type ReconWorkflowInput,
} from '../run/recon/types.js';

/**
 * ORCH-004: the recon phase. Resolves the recon personas for the run's mode, starts one
 * `AgentSessionWorkflow` child per persona in parallel (never above `active_safe`), joins them, asserts
 * the surface model is not empty and audits the result. Returns the state-machine event for the run
 * workflow to apply (`recon_complete` -> planning, `fail` -> failed with `statusReason`); the event is
 * returned only after the surface is finalised and `recon.completed` is audited.
 * One crashed persona is recorded and the phase carries on; all of them crashing fails the run.
 * A cancelled workflow (kill, SA expiry) cancels every child, records the abort and rethrows.
 */
export function ReconWorkflow(input: ReconWorkflowInput): Promise<ReconDecision> {
  const acts = proxyActivities<ReconActivities>({
    startToCloseTimeout: '1 minute',
    retry: {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumAttempts: input.maxAttempts ?? DEFAULT_RECON_ATTEMPTS,
    },
  });
  // One scope for all children so the cost cap can stop the rest at once.
  const scope = new CancellationScope();
  return executeRecon(
    { tenantId: input.tenantId, runId: input.runId },
    {
      acts,
      runChild: (child) =>
        scope.run(() =>
          executeChild(AGENT_SESSION_WORKFLOW, {
            workflowId: `agent-session-${child.sessionId}`,
            args: [child],
            // A stopped recon must stop its sandboxes: cancel the child and wait for it to wind down.
            parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
            cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          }),
        ) as Promise<ReconSessionResult>,
      cancelChildren: () => {
        scope.cancel();
      },
      isCancellation,
      newSessionId: uuid4,
      startedAtMs: workflowInfo().startTime.getTime(),
      shield: (fn) => CancellationScope.nonCancellable(fn),
    },
  );
}
