import type { KillPropagationRequest, KillPropagationSignaler } from './ports.js';

/** Workflow type KILL-004 (#174) registers on the worker. */
export const KILL_PROPAGATION_WORKFLOW = 'KillPropagationWorkflow';
/** Signal carrying the target set into the workflow. */
export const KILL_TARGETS_SIGNAL = 'killTargets';
/** Task queue the kill coordinator polls. */
export const KILL_TASK_QUEUE = 'kill';

/** Workflow id for one kill event: one coordinator per event, so a retried signal never forks it. */
export const killPropagationWorkflowId = (killEventId: string): string =>
  `kill-propagation-${killEventId}`;

/** The slice of `@temporalio/client`'s `WorkflowClient` this adapter uses. */
export interface SignalWithStartClient {
  signalWithStart(
    workflowType: string,
    options: {
      readonly workflowId: string;
      readonly taskQueue: string;
      readonly signal: string;
      readonly signalArgs: readonly [KillPropagationRequest];
      readonly args: readonly [{ readonly killEventId: string; readonly tenantId: string }];
    },
  ): Promise<unknown>;
}

/**
 * Signals (starting if needed) the KILL-004 `KillPropagationWorkflow` with the target set. It returns
 * as soon as Temporal has accepted the signal; it never awaits propagation.
 */
export function createTemporalKillSignaler(
  client: SignalWithStartClient,
  taskQueue: string = KILL_TASK_QUEUE,
): KillPropagationSignaler {
  return {
    async signal(request) {
      await client.signalWithStart(KILL_PROPAGATION_WORKFLOW, {
        workflowId: killPropagationWorkflowId(request.killEventId),
        taskQueue,
        signal: KILL_TARGETS_SIGNAL,
        signalArgs: [request],
        args: [{ killEventId: request.killEventId, tenantId: request.tenantId }],
      });
    },
  };
}
