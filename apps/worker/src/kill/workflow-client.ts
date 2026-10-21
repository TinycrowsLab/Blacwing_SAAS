import type { WorkflowAck, WorkflowControlClient } from './ports.js';

/**
 * The slice of the Temporal client the cancel stage needs, so the adapter does not pull the client
 * package into the worker's runtime dependencies (the composition root passes `client.workflow`).
 */
export interface WorkflowHandleSource {
  getHandle(workflowId: string): { cancel(): Promise<unknown> };
}

const isNamed = (err: unknown, name: string): boolean => err instanceof Error && err.name === name;

/**
 * Adapter over a Temporal client. `cancel()` only requests cancellation: the run workflow's cleanup then
 * runs in its own time, after egress is blocked and the sandboxes are gone. A workflow that is already
 * closed or never started is an idempotent success; any other error is reported as `failed` for that id
 * so one bad id never hides the others.
 */
export function createTemporalWorkflowControlClient(
  source: WorkflowHandleSource,
): WorkflowControlClient {
  return {
    async cancel(request, signal) {
      const acks: WorkflowAck[] = [];
      for (const workflowId of request.workflowIds) {
        if (signal.aborted) {
          acks.push({ workflowId, outcome: 'failed' });
          continue;
        }
        try {
          await source.getHandle(workflowId).cancel();
          acks.push({ workflowId, outcome: 'cancelled' });
        } catch (err) {
          if (isNamed(err, 'WorkflowNotFoundError')) {
            acks.push({ workflowId, outcome: 'not_found' });
          } else {
            acks.push({ workflowId, outcome: 'failed' });
          }
        }
      }
      return acks;
    },
  };
}
