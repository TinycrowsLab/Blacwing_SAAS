import { proxyActivities } from '@temporalio/workflow';

import type * as activities from './activities.js';

const { greet } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

/** Trivial workflow for the DEVENV-007 smoke test. It is not a product workflow. */
export async function smokeWorkflow(name: string): Promise<string> {
  return greet(name);
}
