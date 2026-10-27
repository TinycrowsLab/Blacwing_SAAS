import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';

import type { ReconSessionInput, ReconSessionResult } from './types.js';

// Workflow bundle for the recon integration tests only: the real ReconWorkflow plus a stub
// `AgentSessionWorkflow` (ORCH-006 owns the real one). The stub asks a test activity what the persona does.

export { ReconWorkflow } from '../../workflows/recon.js';

const stub = proxyActivities<{
  stubSession(input: ReconSessionInput): Promise<ReconSessionResult>;
}>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } });

export async function AgentSessionWorkflow(input: ReconSessionInput): Promise<ReconSessionResult> {
  try {
    return await stub.stubSession(input);
  } catch {
    throw ApplicationFailure.nonRetryable('stub session crashed', 'STUB_CRASH');
  }
}
