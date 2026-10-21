import { mapResult, type SubtaskOutcome } from '@blackwing/domain/session-result';

import {
  DEFAULT_SESSION_MAX_DURATION_MS,
  type AgentSessionActivities,
  type AgentSessionInput,
  type AgentSessionResult,
  type IssuedKey,
  type ProvisionedSandbox,
  type RunSessionResult,
  type SessionAuditType,
  type SessionResultMessage,
} from './types.js';

/** Extra key lifetime past the session cap, so a slow teardown never races the key expiring. */
const KEY_TTL_SLACK_MS = 300_000;

/** The two Temporal facilities the lifecycle needs, injected so it runs without a server. */
export interface LifecycleEnv {
  /** Runs `fn` shielded from workflow cancellation (`CancellationScope.nonCancellable`). */
  readonly nonCancellable: <T>(fn: () => Promise<T>) => Promise<T>;
  /** True for a Temporal cancellation (kill or parent cancel), as opposed to an ordinary failure. */
  readonly isCancellation: (error: unknown) => boolean;
}

/** Both provisioning attempts failed; the child fails (ORCH-003 edge case). */
export class SandboxProvisionError extends Error {
  constructor(override readonly cause: unknown) {
    super('sandbox provisioning failed after retry on a different node');
    this.name = 'SandboxProvisionError';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** What the runtime never reported: the session ended without a result (crash, timeout, abort). */
function noResult(sessionId: string | null): SessionResultMessage {
  return {
    subtype: 'error_during_execution',
    is_error: true,
    session_id: sessionId ?? '',
    num_turns: 0,
    total_cost_usd: 0,
    modelUsage: {},
  };
}

/**
 * One persona session, start to finish (ORCH-003): provision, key, run, map, record, and a teardown that
 * runs on success, failure, cancel and kill. Sequential code over injected activities so it is
 * unit-testable without Temporal and deterministic inside the workflow sandbox.
 *
 * - The subtask status comes only from `mapResult` (RUNTIME-013); nothing here maps results.
 * - This never writes `test_cases.status`; the orchestrator does that from the returned subtask status.
 * - The virtual key travels only as a reference (`keyRef`); the `bwk_...` value never enters history.
 */
export async function runAgentSessionLifecycle(
  input: AgentSessionInput,
  sessionRef: string,
  acts: AgentSessionActivities,
  env: LifecycleEnv,
): Promise<AgentSessionResult> {
  const ref = { tenantId: input.tenantId, runId: input.runId, sessionRef };
  const audit = (
    type: SessionAuditType,
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> => acts.emitSessionAudit({ type, ...ref, detail });

  let sandbox: ProvisionedSandbox | null = null;
  let provisionStarted = false;
  let key: IssuedKey | null = null;
  let cancelled = false;

  try {
    provisionStarted = true;
    sandbox = await provisionWithRetry(input, sessionRef, acts, env);
    await audit('sandbox.provisioned', { sandboxId: sandbox.sandboxId });

    key = await acts.issueVirtualKey({
      ...ref,
      model: input.model,
      maxBudgetUsd: input.maxBudgetUsd,
      ttlMs: (input.maxDurationMs ?? DEFAULT_SESSION_MAX_DURATION_MS) + KEY_TTL_SLACK_MS,
    });

    // Written before the run so a kill can resolve this session's sandbox and key from the row.
    await acts.recordSessionStart({
      ...ref,
      ...(input.subtaskId === undefined ? {} : { subtaskId: input.subtaskId }),
      persona: input.persona,
      personaVersion: input.personaVersion,
      model: input.model,
      effort: input.effort,
      sandboxId: sandbox.sandboxId,
      virtualKeyId: key.keyId,
    });
    await audit('session.started', { sandboxId: sandbox.sandboxId, persona: input.persona });

    const run = await runOrSynthesize(input, sessionRef, sandbox, key, acts, env);
    const subtask: SubtaskOutcome = mapResult(run.result);

    await acts.recordSessionFinish({
      ...ref,
      persona: input.persona,
      subtype: run.result.subtype,
      pins: run.pins,
      sessionId: run.result.session_id === '' ? null : run.result.session_id,
      numTurns: run.result.num_turns,
      totalCostUsd: run.result.total_cost_usd,
      modelUsage: run.result.modelUsage,
      transcriptKey: run.transcriptKey,
      subtask,
    });
    await acts.recordSessionCost({ ...ref, persona: input.persona, result: run.result });
    if (subtask.declined) {
      await acts.recordDeclinedCoverage({
        ...ref,
        ...(input.subtaskId === undefined ? {} : { subtaskId: input.subtaskId }),
        persona: input.persona,
        reason: subtask.reason ?? 'refusal',
      });
    }
    await audit('session.finished', {
      sandboxId: sandbox.sandboxId,
      status: subtask.status,
      subtype: run.result.subtype,
      numTurns: run.result.num_turns,
    });

    return {
      sessionRef,
      sessionId: run.result.session_id === '' ? null : run.result.session_id,
      sandboxId: sandbox.sandboxId,
      subtask,
      numTurns: run.result.num_turns,
      totalCostUsd: run.result.total_cost_usd,
    };
  } catch (error) {
    cancelled = env.isCancellation(error);
    throw error;
  } finally {
    if (provisionStarted) {
      await env.nonCancellable(() => teardown(ref, sandbox, key, cancelled, acts));
    }
  }
}

async function provisionWithRetry(
  input: AgentSessionInput,
  sessionRef: string,
  acts: AgentSessionActivities,
  env: LifecycleEnv,
): Promise<ProvisionedSandbox> {
  const base = {
    tenantId: input.tenantId,
    runId: input.runId,
    sessionRef,
    persona: input.persona,
    egressIdentity: input.egressIdentity,
  };
  try {
    return await acts.provisionSandbox({ ...base, differentNode: false });
  } catch (first) {
    if (env.isCancellation(first)) throw first;
    try {
      return await acts.provisionSandbox({ ...base, differentNode: true });
    } catch (second) {
      if (env.isCancellation(second)) throw second;
      throw new SandboxProvisionError(second);
    }
  }
}

/** A run's result, or the synthesized one when the runtime never reported (`pins` is then null). */
type RunOutcome = Omit<RunSessionResult, 'pins'> & {
  readonly pins: RunSessionResult['pins'] | null;
};

async function runOrSynthesize(
  input: AgentSessionInput,
  sessionRef: string,
  sandbox: ProvisionedSandbox,
  key: IssuedKey,
  acts: AgentSessionActivities,
  env: LifecycleEnv,
): Promise<RunOutcome> {
  try {
    return await acts.runAgentSession({
      tenantId: input.tenantId,
      runId: input.runId,
      sessionRef,
      ...(input.subtaskId === undefined ? {} : { subtaskId: input.subtaskId }),
      persona: input.persona,
      personaVersion: input.personaVersion,
      brief: input.brief,
      model: input.model,
      effort: input.effort,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      intrusiveness: input.intrusiveness,
      ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
      egressIdentity: input.egressIdentity,
      ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
      sandboxId: sandbox.sandboxId,
      workspaceDir: sandbox.workspaceDir,
      caRef: sandbox.caRef,
      keyRef: key.keyRef,
    });
  } catch (error) {
    // Cancel and kill propagate (teardown still runs); a crash or timeout becomes an execution error
    // that the one mapper turns into a subtask status, so the parent always gets a status back.
    if (env.isCancellation(error)) throw error;
    return { result: noResult(input.resumeSessionId ?? null), pins: null, transcriptKey: null };
  }
}

/**
 * Revoke the key first (stops spend and model access at once), then best-effort evidence flush, then
 * destroy. Each step is independent: one failing never skips the next. A destroy failure raises the
 * orphan alert and queues the out-of-band retry instead of failing the workflow.
 */
async function teardown(
  ref: { tenantId: string; runId: string; sessionRef: string },
  sandbox: ProvisionedSandbox | null,
  key: IssuedKey | null,
  killed: boolean,
  acts: AgentSessionActivities,
): Promise<void> {
  if (killed) {
    await bestEffort(() =>
      acts.emitSessionAudit({
        type: 'session.killed',
        ...ref,
        detail: { sandboxId: sandbox?.sandboxId ?? null },
      }),
    );
  }
  if (key !== null) {
    const revoked = await bestEffort(() => acts.revokeVirtualKey({ ...ref, keyId: key.keyId }));
    if (!revoked) {
      await bestEffort(() =>
        acts.reportTeardownFailure({
          ...ref,
          kind: 'virtual_key',
          resourceId: key.keyId,
          error: 'virtual key revocation failed after retries',
        }),
      );
    } else {
      await bestEffort(() =>
        acts.emitSessionAudit({
          type: 'virtualkey.revoked',
          ...ref,
          detail: { keyId: key.keyId },
        }),
      );
    }
  }
  if (sandbox !== null) {
    await bestEffort(() => acts.flushEvidence({ ...ref, sandboxId: sandbox.sandboxId }));
  }
  try {
    await acts.destroySandbox({ ...ref, sandboxId: sandbox?.sandboxId ?? null });
    await bestEffort(() =>
      acts.emitSessionAudit({
        type: 'sandbox.destroyed',
        ...ref,
        detail: { sandboxId: sandbox?.sandboxId ?? null },
      }),
    );
  } catch (error) {
    await bestEffort(() =>
      acts.reportTeardownFailure({
        ...ref,
        kind: 'sandbox',
        resourceId: sandbox?.sandboxId ?? null,
        error: errorText(error),
      }),
    );
  }
}

/** Runs one teardown step; a failure is swallowed (the next step must still run) and reported as false. */
async function bestEffort(step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch {
    return false;
  }
}
