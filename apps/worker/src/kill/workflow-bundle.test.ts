import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { KILL_PROPAGATION_WORKFLOW } from './types.js';

describe('KillPropagationWorkflow bundle', () => {
  it('bundles for the deterministic sandbox and exports the workflow under its registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    });
    expect(code).toContain(KILL_PROPAGATION_WORKFLOW);
  }, 60_000);
});
