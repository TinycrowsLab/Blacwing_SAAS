import { condition } from '@temporalio/workflow';

// Workflow bundle for kill-propagation.int.test.ts only. It is not a product workflow.

export { KillPropagationWorkflow } from '../workflows/kill-propagation.js';

/** Stands in for an `AssessmentRunWorkflow`: runs until it is cancelled. */
export async function victimWorkflow(): Promise<void> {
  await condition(() => false);
}
