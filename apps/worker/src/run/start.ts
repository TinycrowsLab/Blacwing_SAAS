import { type RunInput, runInputSchema, runWorkflowId } from '@blackwing/contracts';

import { TASK_QUEUES } from '../task-queues.js';

/** Options for `client.workflow.start(ASSESSMENT_RUN_WORKFLOW, options)`. */
export interface AssessmentRunStartOptions {
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly args: [RunInput];
  readonly workflowIdReusePolicy: 'REJECT_DUPLICATE';
  readonly searchAttributes: Readonly<Record<'tenantId' | 'runId' | 'runState', string[]>>;
}

/**
 * Start options for a run's controller (ORCH-002 req. 6): `workflowId = run_<id>`, the
 * `run-orchestration` task queue and the `tenantId`/`runId`/`runState` search attributes (registered by
 * `infra/compose/temporal/bootstrap.sh`) so Temporal visibility can be listed per tenant.
 *
 * The input is validated here, before anything reaches Temporal: an oversized or malformed `RunInput`
 * throws a `ZodError` and no workflow starts. A repeated start for the same run is refused by Temporal
 * (the id is the run id), so a retried API call cannot create a second controller.
 */
export function assessmentRunStartOptions(rawInput: unknown): AssessmentRunStartOptions {
  const input = runInputSchema.parse(rawInput);
  return {
    workflowId: runWorkflowId(input.runId),
    taskQueue: TASK_QUEUES.RUN_ORCHESTRATION,
    args: [input],
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
    searchAttributes: { tenantId: [input.tenantId], runId: [input.runId], runState: ['draft'] },
  };
}
