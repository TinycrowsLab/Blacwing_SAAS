import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

describe('AssessmentRunWorkflow bundle', () => {
  it('bundles for the deterministic sandbox (no Node built-ins) and exports the workflow', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
    });
    expect(code).toContain('AssessmentRunWorkflow');
  }, 120_000);
});
