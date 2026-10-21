import {
  type ActivityOptions,
  CancellationScope,
  isCancellation,
  proxyActivities,
  uuid4,
  ApplicationFailure,
} from '@temporalio/workflow';

import { runAgentSessionLifecycle, SandboxProvisionError } from '../agent-session/lifecycle.js';
import {
  DEFAULT_SESSION_MAX_DURATION_MS,
  DESTROY_MAX_ATTEMPTS,
  EVIDENCE_FLUSH_DEADLINE_MS,
  FLUSH_MAX_ATTEMPTS,
  KEY_REVOKE_DEADLINE_MS,
  REVOKE_MAX_ATTEMPTS,
  SANDBOX_DESTROY_DEADLINE_MS,
  SESSION_HEARTBEAT_TIMEOUT_MS,
  type AgentSessionActivities,
  type AgentSessionInput,
  type AgentSessionResult,
} from '../agent-session/types.js';

const ms = (value: number): string => `${String(value)} milliseconds`;

// Provisioning retries are the workflow's call (one retry on a different node), so Temporal makes a
// single attempt per call.
const provisionActs = proxyActivities<AgentSessionActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

// Bookkeeping activities are idempotent upserts: retry freely.
const recordActs = proxyActivities<AgentSessionActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '200 milliseconds', backoffCoefficient: 2, maximumAttempts: 5 },
});

// Teardown budgets follow §8.5; destroy and revoke retry briefly and then fall to the orphan path.
const teardownOptions = (deadlineMs: number, attempts: number): ActivityOptions => ({
  startToCloseTimeout: ms(deadlineMs),
  retry: { initialInterval: '100 milliseconds', backoffCoefficient: 2, maximumAttempts: attempts },
});
const flushActs = proxyActivities<AgentSessionActivities>(
  teardownOptions(EVIDENCE_FLUSH_DEADLINE_MS, FLUSH_MAX_ATTEMPTS),
);
const revokeActs = proxyActivities<AgentSessionActivities>(
  teardownOptions(KEY_REVOKE_DEADLINE_MS, REVOKE_MAX_ATTEMPTS),
);
const destroyActs = proxyActivities<AgentSessionActivities>(
  teardownOptions(SANDBOX_DESTROY_DEADLINE_MS, DESTROY_MAX_ATTEMPTS),
);

/**
 * Builds the session-run proxy for one input: the activity timeout is the session's wall-clock cap, and
 * on timeout or cancel the activity aborts the SDK through its `abortController`. A heartbeat timeout
 * detects a lost worker; the runtime's `sessionStore` then lets the retry resume on the replacement.
 */
function runActs(input: AgentSessionInput): AgentSessionActivities {
  return proxyActivities<AgentSessionActivities>({
    startToCloseTimeout: ms(input.maxDurationMs ?? DEFAULT_SESSION_MAX_DURATION_MS),
    heartbeatTimeout: ms(SESSION_HEARTBEAT_TIMEOUT_MS),
    cancellationType: 'WAIT_CANCELLATION_COMPLETED',
    retry: { maximumAttempts: 1 },
  });
}

/**
 * ORCH-003: runs exactly one persona session: provision a disposable sandbox, run the Agent SDK
 * session, map the result with the authoritative `mapResult`, and tear everything down, including on
 * failure, cancel and kill. Returns the SUBTASK status; the orchestrator, not this workflow, moves the
 * test case.
 */
export async function AgentSessionWorkflow(input: AgentSessionInput): Promise<AgentSessionResult> {
  const run = runActs(input);
  const acts: AgentSessionActivities = {
    provisionSandbox: (r) => provisionActs.provisionSandbox(r),
    issueVirtualKey: (r) => recordActs.issueVirtualKey(r),
    recordSessionStart: (r) => recordActs.recordSessionStart(r),
    runAgentSession: (r) => run.runAgentSession(r),
    recordSessionFinish: (r) => recordActs.recordSessionFinish(r),
    recordSessionCost: (r) => recordActs.recordSessionCost(r),
    recordDeclinedCoverage: (r) => recordActs.recordDeclinedCoverage(r),
    emitSessionAudit: (r) => recordActs.emitSessionAudit(r),
    flushEvidence: (r) => flushActs.flushEvidence(r),
    revokeVirtualKey: (r) => revokeActs.revokeVirtualKey(r),
    destroySandbox: (r) => destroyActs.destroySandbox(r),
    reportTeardownFailure: (r) => recordActs.reportTeardownFailure(r),
  };
  try {
    return await runAgentSessionLifecycle(input, uuid4(), acts, {
      nonCancellable: (fn) => CancellationScope.nonCancellable(fn),
      isCancellation,
    });
  } catch (error) {
    if (error instanceof SandboxProvisionError) {
      throw ApplicationFailure.nonRetryable(error.message, 'SandboxProvisionFailed');
    }
    throw error;
  }
}
