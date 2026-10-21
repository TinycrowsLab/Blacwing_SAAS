import type {
  KillActivities,
  KillLaterStage,
  KillProgress,
  KillPropagationRequest,
} from './types.js';

/** True when the kill has nothing to stop. */
export function isEmptyTargetSet(request: KillPropagationRequest): boolean {
  const t = request.targets;
  return (
    t.runIds.length === 0 &&
    t.sessionIds.length === 0 &&
    t.sandboxIds.length === 0 &&
    t.virtualKeyIds.length === 0 &&
    t.egressIdentities.length === 0 &&
    t.workflowIds.length === 0
  );
}

/**
 * The fixed §8.5 order, as sequential code over injected activities (so it is unit-testable without a
 * Temporal server and deterministic inside the workflow sandbox): egress block, then each later stage
 * one after the other, then finalize.
 *
 * An egress failure never stops the kill: the gateway fails closed by design (§8.2), the egress stage
 * records `partially_halted`, and the remaining stages still run. A later stage that throws does not
 * skip the stages after it.
 */
export async function runKillPropagation(
  request: KillPropagationRequest,
  acts: KillActivities,
  laterStages: readonly KillLaterStage[],
  progress: { current: KillProgress },
): Promise<void> {
  const ref = { tenantId: request.tenantId, killEventId: request.killEventId };
  const set = (patch: Partial<KillProgress>): void => {
    progress.current = { ...progress.current, ...patch };
  };

  if (isEmptyTargetSet(request)) {
    await acts.completeEmptyKill(ref);
    set({ stage: 'done', completed: true });
    return;
  }

  set({ stage: 'egress' });
  try {
    const result = await acts.blockEgress({
      ...ref,
      identities: request.targets.egressIdentities,
    });
    set({ egress: result.outcome });
    try {
      await acts.auditEgressBlocked({ ...ref, result });
    } catch {
      // The audit activity is retried by Temporal; if it still fails the kill must go on.
    }
  } catch {
    // Infrastructure failure while recording: the gateway already fails closed. Continue (§8.5).
    set({ egress: 'partially_halted' });
  }

  for (const stage of laterStages) {
    set({ stage: stage.name });
    try {
      await stage.run(request);
    } catch {
      // Left unrecorded: finalize will not complete the event, and the reconciler resumes it.
    }
  }

  set({ stage: 'finalizing' });
  const { completed } = await acts.finalizeKill(ref);
  set({ stage: 'done', completed });
}
