import { SpanStatusCode, trace } from '@opentelemetry/api';

import {
  computeKillHalt,
  type KillEgressIdentity,
  type KillEgressOutcome,
  type KillKeyOutcome,
  type KillSandboxOutcome,
  type KillWorkflowOutcome,
} from '@blackwing/contracts';

import {
  EGRESS_BACKOFF_BASE_MS,
  EGRESS_DEADLINE_MS,
  EGRESS_MAX_ATTEMPTS,
  KEY_BACKOFF_BASE_MS,
  KEY_DEADLINE_MS,
  SANDBOX_BACKOFF_BASE_MS,
  SANDBOX_DEADLINE_MS,
  WORKFLOW_BACKOFF_BASE_MS,
  WORKFLOW_DEADLINE_MS,
  type KeyIdResult,
  type KeyStageResult,
  type WorkflowIdResult,
  type WorkflowStageResult,
  type SandboxIdResult,
  type SandboxStageResult,
  type EgressIdentityResult,
  type EgressStageResult,
  type KillActivities,
  type KillEventState,
} from './types.js';

import type {
  EgressControlClient,
  KillEventRepo,
  KeyControlClient,
  KillStageAuditSink,
  KillStageMetrics,
  ReversalJournal,
  SandboxControlClient,
  WorkflowControlClient,
} from './ports.js';
import type { Logger } from '@blackwing/logger';

export interface KillActivityDeps {
  readonly repo: KillEventRepo;
  readonly egress: EgressControlClient;
  readonly sandboxes: SandboxControlClient;
  readonly keys: KeyControlClient;
  readonly workflows: WorkflowControlClient;
  readonly reversals: ReversalJournal;
  readonly audit: KillStageAuditSink;
  readonly metrics: KillStageMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seams; production uses the §8.5 constants. */
  readonly deadlineMs?: number;
  readonly backoffBaseMs?: number;
  readonly maxAttempts?: number;
  /** Sandbox stage deadline (`KILL_SANDBOX_DEADLINE_MS`, default 10 s). */
  readonly sandboxDeadlineMs?: number;
  readonly sandboxBackoffBaseMs?: number;
  /** Key stage deadline; keys are short-lived, so expiry backs up a revoke that cannot be acked. */
  readonly keyDeadlineMs?: number;
  readonly keyBackoffBaseMs?: number;
  readonly workflowDeadlineMs?: number;
  readonly workflowBackoffBaseMs?: number;
}

/** Stable, opaque key for an identity: `run:<runId>` or `principal:<tc_..role_..>`. */
export function egressIdentityKey(identity: KillEgressIdentity): string {
  return identity.kind === 'run' ? `run:${identity.runId}` : `principal:${identity.principal}`;
}

const tracer = trace.getTracer('@blackwing/worker');

async function requireEvent(
  repo: KillEventRepo,
  tenantId: string,
  killEventId: string,
): Promise<KillEventState> {
  const event = await repo.get(tenantId, killEventId);
  if (event === null) {
    // A missing row is not retryable: the id is wrong or the tenant does not match (RLS hides it).
    throw new Error(`kill event ${killEventId} not found for tenant`);
  }
  return event;
}

/** Builds the kill activities over their ports. Each one is idempotent (compare-and-set writes). */
export function createKillActivities(deps: KillActivityDeps): KillActivities {
  const now = deps.now ?? ((): Date => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }));
  const deadlineMs = deps.deadlineMs ?? EGRESS_DEADLINE_MS;
  const backoffBaseMs = deps.backoffBaseMs ?? EGRESS_BACKOFF_BASE_MS;
  const maxAttempts = deps.maxAttempts ?? EGRESS_MAX_ATTEMPTS;
  const sandboxDeadlineMs = deps.sandboxDeadlineMs ?? SANDBOX_DEADLINE_MS;
  const sandboxBackoffMs = deps.sandboxBackoffBaseMs ?? SANDBOX_BACKOFF_BASE_MS;
  const keyDeadlineMs = deps.keyDeadlineMs ?? KEY_DEADLINE_MS;
  const keyBackoffMs = deps.keyBackoffBaseMs ?? KEY_BACKOFF_BASE_MS;
  const workflowDeadlineMs = deps.workflowDeadlineMs ?? WORKFLOW_DEADLINE_MS;
  const workflowBackoffMs = deps.workflowBackoffBaseMs ?? WORKFLOW_BACKOFF_BASE_MS;
  const { repo, log } = deps;

  /**
   * Asks `call` for every id until each is settled (any outcome but `failed`) or the deadline passes.
   * Shared by the key and workflow stages; the egress and sandbox stages keep their own loops.
   */
  async function settleWithRetry<O extends string>(
    ids: readonly string[],
    failed: O,
    deadlineMsFor: number,
    backoffBaseFor: number,
    startedMs: number,
    call: (pending: readonly string[], signal: AbortSignal) => Promise<readonly [string, O][]>,
    what: string,
    killEventId: string,
  ): Promise<{ results: { id: string; outcome: O }[]; attempts: number }> {
    const settled = new Map<string, O>();
    let pending = [...ids];
    let attempts = 0;
    for (;;) {
      const remaining = deadlineMsFor - (now().getTime() - startedMs);
      if (pending.length === 0 || remaining <= 0) break;
      attempts += 1;
      try {
        const acks = await call(pending, AbortSignal.timeout(remaining));
        const asked = new Set(pending);
        for (const [id, outcome] of acks) {
          if (asked.has(id) && outcome !== failed) settled.set(id, outcome);
        }
      } catch (err) {
        log.warn({ killEventId, attempt: attempts, err }, `${what} attempt failed`);
      }
      pending = pending.filter((id) => !settled.has(id));
      if (pending.length === 0) break;
      const backoff = backoffBaseFor * 2 ** (attempts - 1);
      if (now().getTime() - startedMs + backoff >= deadlineMsFor) break;
      await sleep(backoff);
    }
    return {
      attempts,
      results: ids.map((id) => ({ id, outcome: settled.get(id) ?? failed })),
    };
  }

  /** Asks the controller until every id is settled (anything but `failed`) or the deadline passes. */
  async function terminateWithRetry(
    killEventId: string,
    sandboxIds: readonly string[],
    startedMs: number,
  ): Promise<{ results: SandboxIdResult[]; attempts: number }> {
    const settled = new Map<string, KillSandboxOutcome>();
    let pending = [...sandboxIds];
    let attempts = 0;
    for (;;) {
      const remaining = sandboxDeadlineMs - (now().getTime() - startedMs);
      if (pending.length === 0 || remaining <= 0) break;
      attempts += 1;
      try {
        const acks = await deps.sandboxes.terminate(
          { killEventId, sandboxIds: pending },
          AbortSignal.timeout(remaining),
        );
        const asked = new Set(pending);
        for (const ack of acks) {
          if (asked.has(ack.sandboxId) && ack.outcome !== 'failed') {
            settled.set(ack.sandboxId, ack.outcome);
          }
        }
      } catch (err) {
        log.warn({ killEventId, attempt: attempts, err }, 'sandbox terminate attempt failed');
      }
      pending = pending.filter((id) => !settled.has(id));
      if (pending.length === 0) break;
      const backoff = sandboxBackoffMs * 2 ** (attempts - 1);
      if (now().getTime() - startedMs + backoff >= sandboxDeadlineMs) break;
      await sleep(backoff);
    }
    return {
      attempts,
      results: sandboxIds.map((sandboxId) => ({
        sandboxId,
        outcome: settled.get(sandboxId) ?? 'failed',
      })),
    };
  }

  async function blockWithRetry(
    killEventId: string,
    identities: readonly KillEgressIdentity[],
    startedMs: number,
  ): Promise<{ results: EgressIdentityResult[]; attempts: number }> {
    const settled = new Map<string, KillEgressOutcome>();
    let pending = [...identities];
    let attempts = 0;
    while (pending.length > 0 && attempts < maxAttempts) {
      const remaining = deadlineMs - (now().getTime() - startedMs);
      if (remaining <= 0) break;
      attempts += 1;
      try {
        const acks = await deps.egress.block(
          { killEventId, identities: pending },
          AbortSignal.timeout(remaining),
        );
        const asked = new Set(pending.map((identity) => egressIdentityKey(identity)));
        for (const ack of acks) {
          const key = egressIdentityKey(ack.identity);
          if (asked.has(key) && ack.outcome !== 'failed') settled.set(key, ack.outcome);
        }
      } catch (err) {
        log.warn({ killEventId, attempt: attempts, err }, 'egress block attempt failed');
      }
      pending = pending.filter((identity) => !settled.has(egressIdentityKey(identity)));
      if (pending.length === 0) break;
      const backoff = backoffBaseMs * 2 ** (attempts - 1);
      if (attempts >= maxAttempts || now().getTime() - startedMs + backoff >= deadlineMs) break;
      await sleep(backoff);
    }
    return {
      attempts,
      results: identities.map((identity) => {
        const key = egressIdentityKey(identity);
        return { identity: key, outcome: settled.get(key) ?? 'failed' };
      }),
    };
  }

  return {
    async blockEgress({ tenantId, killEventId, identities }) {
      return tracer.startActiveSpan('kill.stage.egress', async (span) => {
        span.setAttribute('kill.event_id', killEventId);
        span.setAttribute('kill.identities', identities.length);
        const started = now();
        try {
          const event = await requireEvent(repo, tenantId, killEventId);
          if (event.egressBlockedAt !== null) {
            // Re-run for an already-blocked event: no second block, no timestamp reset.
            deps.metrics.stageResult('egress', 'skipped');
            return {
              outcome: 'skipped',
              identities: [],
              attempts: 0,
              latencyMs: 0,
            } satisfies EgressStageResult;
          }

          const { results, attempts } = await blockWithRetry(
            killEventId,
            identities,
            started.getTime(),
          );
          for (const r of results) {
            log.info(
              { killEventId, identity: r.identity, outcome: r.outcome },
              'egress identity result',
            );
          }
          await repo.mergeAffected(tenantId, killEventId, {
            egress: results.map((r) => ({ identity: r.identity, outcome: r.outcome })),
          });

          const allBlocked = results.every((r) => r.outcome !== 'failed');
          const finished = now();
          const latencyMs = Math.max(0, finished.getTime() - started.getTime());
          if (allBlocked) {
            await repo.markStage(tenantId, killEventId, 'egressBlockedAt', finished);
            await repo.transition(tenantId, killEventId, 'propagating', ['initiated']);
          } else {
            // The gateway fails closed on its own (§8.2); record it and let the kill carry on.
            await repo.transition(tenantId, killEventId, 'partially_halted', [
              'initiated',
              'propagating',
            ]);
            deps.metrics.partialHalt('egress');
          }
          const outcome = allBlocked ? 'blocked' : 'partially_halted';
          deps.metrics.stageLatency('egress', latencyMs);
          deps.metrics.stageResult('egress', outcome);
          span.setAttribute('kill.egress.outcome', outcome);
          return { outcome, identities: results, attempts, latencyMs } satisfies EgressStageResult;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.metrics.stageResult('egress', 'error');
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async auditEgressBlocked({ tenantId, killEventId, result }) {
      if (result.outcome === 'skipped') return;
      const metadata: Record<string, string | number | boolean | null> = {
        stage: 'egress',
        outcome: result.outcome,
        attempts: result.attempts,
        latencyMs: result.latencyMs,
      };
      for (const r of result.identities) metadata[`identity.${r.identity}`] = r.outcome;
      await deps.audit.append({
        action: 'kill.egress_blocked',
        severity: 'critical',
        outcome: result.outcome === 'blocked' ? 'success' : 'failure',
        tenantId,
        killEventId,
        occurredAt: now().toISOString(),
        metadata,
      });
    },

    async terminateSandboxes({ tenantId, killEventId, sandboxIds }) {
      return tracer.startActiveSpan('kill.stage.sandbox', async (span) => {
        span.setAttribute('kill.event_id', killEventId);
        span.setAttribute('kill.sandboxes', sandboxIds.length);
        const started = now();
        try {
          const event = await requireEvent(repo, tenantId, killEventId);
          if (event.sandboxesTerminatedAt !== null) {
            // Re-run: the stage already recorded; do not call the controller again.
            deps.metrics.stageResult('sandbox', 'skipped');
            return {
              outcome: 'skipped',
              sandboxes: [],
              attempts: 0,
              latencyMs: 0,
            } satisfies SandboxStageResult;
          }

          const unique = [...new Set(sandboxIds)];
          const { results, attempts } = await terminateWithRetry(
            killEventId,
            unique,
            started.getTime(),
          );
          for (const r of results) {
            log.info({ killEventId, sandboxId: r.sandboxId, outcome: r.outcome }, 'sandbox result');
          }
          const done = results.filter(
            (r) => r.outcome === 'terminated' || r.outcome === 'already_gone',
          );
          await repo.mergeAffected(tenantId, killEventId, {
            sandboxes: done.length,
            sandboxResults: results.map((r) => ({ sandboxId: r.sandboxId, outcome: r.outcome })),
          });
          const clean = done.length === results.length;
          const finished = now();
          const latencyMs = Math.max(0, finished.getTime() - started.getTime());
          // Stamped on full ack or at the deadline: a lingering sandbox is already egress-isolated (stage 1),
          // so the kill never waits on it.
          await repo.markStage(tenantId, killEventId, 'sandboxesTerminatedAt', finished);
          if (!clean) {
            await repo.transition(tenantId, killEventId, 'partially_halted', [
              'initiated',
              'propagating',
            ]);
            deps.metrics.partialHalt('sandbox');
          }
          deps.metrics.sandboxesTerminated(done.length);
          const outcome = clean ? 'terminated' : 'partially_halted';
          deps.metrics.stageLatency('sandbox', latencyMs);
          deps.metrics.stageResult('sandbox', outcome);
          span.setAttribute('kill.sandbox.outcome', outcome);
          return { outcome, sandboxes: results, attempts, latencyMs } satisfies SandboxStageResult;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.metrics.stageResult('sandbox', 'error');
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async auditSandboxesTerminated({ tenantId, killEventId, result }) {
      if (result.outcome === 'skipped') return;
      const count = (o: readonly KillSandboxOutcome[]): number =>
        result.sandboxes.filter((s) => o.includes(s.outcome)).length;
      await deps.audit.append({
        action: 'kill.sandboxes_terminated',
        severity: 'critical',
        outcome: result.outcome === 'terminated' ? 'success' : 'failure',
        tenantId,
        killEventId,
        occurredAt: now().toISOString(),
        metadata: {
          stage: 'sandbox',
          outcome: result.outcome,
          total: result.sandboxes.length,
          terminated: count(['terminated']),
          alreadyGone: count(['already_gone']),
          terminating: count(['terminating']),
          failed: count(['failed']),
          attempts: result.attempts,
          latencyMs: result.latencyMs,
        },
      });
    },

    async revokeKeys({ tenantId, killEventId, keyIds }) {
      return tracer.startActiveSpan('kill.stage.keys', async (span) => {
        span.setAttribute('kill.event_id', killEventId);
        span.setAttribute('kill.keys', keyIds.length);
        const started = now();
        try {
          const event = await requireEvent(repo, tenantId, killEventId);
          if (event.keysRevokedAt !== null) {
            deps.metrics.stageResult('keys', 'skipped');
            return {
              outcome: 'skipped',
              keys: [],
              attempts: 0,
              latencyMs: 0,
            } satisfies KeyStageResult;
          }

          const unique = [...new Set(keyIds)];
          const { results: raw, attempts } = await settleWithRetry<KillKeyOutcome>(
            unique,
            'failed',
            keyDeadlineMs,
            keyBackoffMs,
            started.getTime(),
            async (pending, signal) =>
              (await deps.keys.revoke({ killEventId, keyIds: pending }, signal)).map(
                (a) => [a.keyId, a.outcome] as [string, KillKeyOutcome],
              ),
            'key revoke',
            killEventId,
          );
          const results: KeyIdResult[] = raw.map((r) => ({ keyId: r.id, outcome: r.outcome }));
          for (const r of results) {
            log.info({ killEventId, keyId: r.keyId, outcome: r.outcome }, 'key result');
          }
          const done = results.filter((r) => r.outcome !== 'failed');
          await repo.mergeAffected(tenantId, killEventId, {
            keys: done.length,
            keyResults: results.map((r) => ({ keyId: r.keyId, outcome: r.outcome })),
          });
          const clean = done.length === results.length;
          const finished = now();
          const latencyMs = Math.max(0, finished.getTime() - started.getTime());
          // Stamped on full ack or at the deadline: keys are short-lived, so an unrevoked key expires on its
          // own, and the sandboxes and egress behind it are already gone (stages 1 and 2).
          await repo.markStage(tenantId, killEventId, 'keysRevokedAt', finished);
          if (!clean) {
            await repo.transition(tenantId, killEventId, 'partially_halted', [
              'initiated',
              'propagating',
            ]);
            deps.metrics.partialHalt('keys');
          }
          deps.metrics.keysRevoked(done.length);
          const outcome = clean ? 'revoked' : 'partially_halted';
          deps.metrics.stageLatency('keys', latencyMs);
          deps.metrics.stageResult('keys', outcome);
          span.setAttribute('kill.keys.outcome', outcome);
          return { outcome, keys: results, attempts, latencyMs } satisfies KeyStageResult;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.metrics.stageResult('keys', 'error');
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async auditKeysRevoked({ tenantId, killEventId, result }) {
      if (result.outcome === 'skipped') return;
      const count = (o: KillKeyOutcome): number =>
        result.keys.filter((k) => k.outcome === o).length;
      await deps.audit.append({
        action: 'kill.keys_revoked',
        severity: 'critical',
        outcome: result.outcome === 'revoked' ? 'success' : 'failure',
        tenantId,
        killEventId,
        occurredAt: now().toISOString(),
        metadata: {
          stage: 'keys',
          outcome: result.outcome,
          total: result.keys.length,
          revoked: count('revoked'),
          alreadyRevoked: count('already_revoked'),
          failed: count('failed'),
          attempts: result.attempts,
          latencyMs: result.latencyMs,
        },
      });
    },

    async cancelWorkflows({ tenantId, killEventId, workflowIds, runIds }) {
      return tracer.startActiveSpan('kill.stage.workflows', async (span) => {
        span.setAttribute('kill.event_id', killEventId);
        span.setAttribute('kill.workflows', workflowIds.length);
        const started = now();
        try {
          const event = await requireEvent(repo, tenantId, killEventId);
          if (event.workflowsCancelledAt !== null) {
            deps.metrics.stageResult('workflows', 'skipped');
            return {
              outcome: 'skipped',
              workflows: [],
              reversalsFlagged: 0,
              attempts: 0,
              latencyMs: 0,
            } satisfies WorkflowStageResult;
          }

          const unique = [...new Set(workflowIds)];
          const { results: raw, attempts } = await settleWithRetry<KillWorkflowOutcome>(
            unique,
            'failed',
            workflowDeadlineMs,
            workflowBackoffMs,
            started.getTime(),
            async (pending, signal) =>
              (await deps.workflows.cancel({ killEventId, workflowIds: pending }, signal)).map(
                (a) => [a.workflowId, a.outcome] as [string, KillWorkflowOutcome],
              ),
            'workflow cancel',
            killEventId,
          );
          const results: WorkflowIdResult[] = raw.map((r) => ({
            workflowId: r.id,
            outcome: r.outcome,
          }));
          for (const r of results) {
            log.info(
              { killEventId, workflowId: r.workflowId, outcome: r.outcome },
              'workflow result',
            );
          }
          const done = results.filter((r) => r.outcome !== 'failed');
          // Pending reversal entries are flagged for the reversal process, never undone here (§8.5). A
          // failure throws before the stage is stamped, so Temporal (or the reconciler) retries it.
          const reversalsFlagged = await deps.reversals.flagPending(tenantId, killEventId, [
            ...new Set(runIds),
          ]);
          await repo.mergeAffected(tenantId, killEventId, {
            workflows: done.length,
            workflowResults: results.map((r) => ({
              workflowId: r.workflowId,
              outcome: r.outcome,
            })),
            reversalsFlagged,
          });
          const clean = done.length === results.length;
          const finished = now();
          const latencyMs = Math.max(0, finished.getTime() - started.getTime());
          await repo.markStage(tenantId, killEventId, 'workflowsCancelledAt', finished);
          if (!clean) {
            await repo.transition(tenantId, killEventId, 'partially_halted', [
              'initiated',
              'propagating',
            ]);
            deps.metrics.partialHalt('workflows');
          }
          deps.metrics.workflowsCancelled(done.length);
          const outcome = clean ? 'cancelled' : 'partially_halted';
          deps.metrics.stageLatency('workflows', latencyMs);
          deps.metrics.stageResult('workflows', outcome);
          span.setAttribute('kill.workflows.outcome', outcome);
          return {
            outcome,
            workflows: results,
            reversalsFlagged,
            attempts,
            latencyMs,
          } satisfies WorkflowStageResult;
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          deps.metrics.stageResult('workflows', 'error');
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async auditWorkflowsCancelled({ tenantId, killEventId, result }) {
      if (result.outcome === 'skipped') return;
      const count = (o: KillWorkflowOutcome): number =>
        result.workflows.filter((w) => w.outcome === o).length;
      await deps.audit.append({
        action: 'kill.workflows_cancelled',
        severity: 'critical',
        outcome: result.outcome === 'cancelled' ? 'success' : 'failure',
        tenantId,
        killEventId,
        occurredAt: now().toISOString(),
        metadata: {
          stage: 'workflows',
          outcome: result.outcome,
          total: result.workflows.length,
          cancelled: count('cancelled'),
          alreadyClosed: count('already_closed'),
          notFound: count('not_found'),
          failed: count('failed'),
          reversalsFlagged: result.reversalsFlagged,
          attempts: result.attempts,
          latencyMs: result.latencyMs,
        },
      });
    },

    async completeEmptyKill({ tenantId, killEventId }) {
      const event = await requireEvent(repo, tenantId, killEventId);
      if (event.completedAt !== null) return;
      const won = await repo.complete(tenantId, killEventId, {
        status: 'halted',
        completedAt: now(),
        haltMs: 0,
      });
      if (won) deps.metrics.haltMs(0);
      deps.metrics.stageResult('egress', 'nothing_to_stop');
    },

    async finalizeKill({ tenantId, killEventId }) {
      const event = await requireEvent(repo, tenantId, killEventId);
      if (event.completedAt !== null) return { completed: true };
      // KILL-005/006 record their own stage timestamps; until all have, the event stays open.
      if (
        event.sandboxesTerminatedAt === null ||
        event.keysRevokedAt === null ||
        event.workflowsCancelledAt === null
      ) {
        return { completed: false };
      }
      const completedAt = now();
      const timings = computeKillHalt({ ...event, completedAt });
      const clean = event.egressBlockedAt !== null && event.status !== 'partially_halted';
      // Server timestamps only: the halt time is never taken from a client or from the signal payload.
      const haltMs = timings.haltMs ?? 0;
      const won = await repo.complete(tenantId, killEventId, {
        status: clean ? 'halted' : 'partially_halted',
        completedAt,
        haltMs,
      });
      if (won) deps.metrics.haltMs(haltMs);
      if (timings.clamped) {
        deps.log.warn({ killEventId }, 'kill timestamps went backwards; halt delta clamped');
      }
      return { completed: true };
    },

    async auditKillCompleted({ tenantId, killEventId }) {
      const event = await requireEvent(repo, tenantId, killEventId);
      if (event.completedAt === null) return;
      await deps.audit.append({
        action: 'kill.completed',
        severity: 'critical',
        outcome: event.status === 'halted' ? 'success' : 'failure',
        tenantId,
        killEventId,
        occurredAt: event.completedAt.toISOString(),
        metadata: {
          status: event.status,
          haltMs: Math.max(0, event.completedAt.getTime() - event.triggeredAt.getTime()),
        },
      });
    },
  };
}
