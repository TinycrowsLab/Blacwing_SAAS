import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_WORKFLOW } from './types.js';

describe('AgentSessionWorkflow bundle', () => {
  it('bundles for the deterministic sandbox (mapper included) and exports the registered name', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
    });
    expect(code).toContain(AGENT_SESSION_WORKFLOW);
  }, 60_000);
});
