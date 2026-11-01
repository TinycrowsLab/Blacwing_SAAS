import type { ScheduleRunInput } from './spec.js';

/**
 * Test double of the run workflow a schedule starts (ORCH owns the real `AssessmentRunWorkflow`). It returns the input it
 * was started with, so the integration test can check what a fired schedule carries.
 */
export function AssessmentRunWorkflow(input: ScheduleRunInput): Promise<ScheduleRunInput> {
  return Promise.resolve(input);
}
