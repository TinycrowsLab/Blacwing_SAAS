import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { EXECUTION_WORKFLOW } from '../run/execution/types.js';
import { POST_EXECUTION_WORKFLOW } from '../run/postexec/types.js';
import { PREFLIGHT_WORKFLOW } from '../run/preflight/types.js';
import { RECON_WORKFLOW } from '../run/recon/types.js';

describe('PreflightWorkflow bundle', () => {
  it('bundles for the deterministic sandbox and exports the workflow under its registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
    });
    expect(code).toContain(PREFLIGHT_WORKFLOW);
    expect(code).toContain(POST_EXECUTION_WORKFLOW);
    expect(code).toContain(RECON_WORKFLOW);
    expect(code).toContain(EXECUTION_WORKFLOW);
  }, 60_000);
});
