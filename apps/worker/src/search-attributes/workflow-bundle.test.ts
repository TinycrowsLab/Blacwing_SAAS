import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

describe('search attribute probe workflow bundle', () => {
  it('bundles for the deterministic sandbox with the search attribute helpers and exports the probe', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./probe-workflows.ts', import.meta.url)),
    });
    expect(code).toContain('runStateProbeWorkflow');
    expect(code).toContain('upsertSearchAttributes');
  }, 60_000);
});
