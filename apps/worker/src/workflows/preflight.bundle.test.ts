import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { PREFLIGHT_WORKFLOW } from '../run/preflight/types.js';

describe('PreflightWorkflow bundle', () => {
  it('bundles for the deterministic sandbox and exports the workflow under its registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
    });
    expect(code).toContain(PREFLIGHT_WORKFLOW);
  }, 60_000);
});
