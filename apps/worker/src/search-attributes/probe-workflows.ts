import { condition, defineSignal, setHandler } from '@temporalio/workflow';

import { upsertRunSearchAttributes } from '../search-attributes.js';

/** Signal that lets the probe workflow finish once the visibility assertion has run. */
export const releaseProbeSignal = defineSignal('releaseProbe');

/**
 * Test-only workflow for the WORKFLOW-003 integration test. It moves itself to `executing` through
 * `upsertRunSearchAttributes`, then stays open until released, so the test can find it by visibility query.
 * It is not a product workflow.
 */
export async function runStateProbeWorkflow(): Promise<string> {
  let released = false;
  setHandler(releaseProbeSignal, () => {
    released = true;
  });
  upsertRunSearchAttributes('executing');
  await condition(() => released);
  return 'released';
}
