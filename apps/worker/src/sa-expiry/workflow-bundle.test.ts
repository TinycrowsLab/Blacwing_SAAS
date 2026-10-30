import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { SA_EXPIRY_WORKFLOW } from './types.js';

describe('SaExpiryWorkflow bundle (AUTHZ-010)', () => {
  it('bundles for the deterministic sandbox and exports the workflow under its registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    });
    expect(code).toContain(SA_EXPIRY_WORKFLOW);
  }, 60_000);
});
