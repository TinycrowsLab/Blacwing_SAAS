import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { WORKFLOW_INTERCEPTOR_MODULE } from './context.js';

describe('workflow context interceptor bundle', () => {
  it('bundles with the workflows for the deterministic sandbox, with no Node-only imports', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
      workflowInterceptorModules: [WORKFLOW_INTERCEPTOR_MODULE],
    });
    expect(code).toContain('x-bw-tenant-id');
    expect(code).toContain('bwContext');
    expect(code).toContain('MISSING_TENANT_CONTEXT');
    // The telemetry package (AsyncLocalStorage, node:crypto) must never reach the sandbox.
    expect(code).not.toContain('no workflow context is active on this call path');
    expect(code).not.toContain('randomBytes');
  }, 60_000);
});
