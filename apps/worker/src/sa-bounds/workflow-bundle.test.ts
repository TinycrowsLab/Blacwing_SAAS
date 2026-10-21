import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { SA_TIME_BOUNDS_WORKFLOW } from './types.js';

describe('SaTimeBoundsWorkflow bundle', () => {
  it('bundles for the deterministic sandbox and exports the workflow under its registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    });
    expect(code).toContain(SA_TIME_BOUNDS_WORKFLOW);
  }, 60_000);
});
