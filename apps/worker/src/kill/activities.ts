import { SpanStatusCode, trace } from '@opentelemetry/api';

import {
  EGRESS_BACKOFF_BASE_MS,
  EGRESS_DEADLINE_MS,
  EGRESS_MAX_ATTEMPTS,
  type EgressIdentityResult,
  type EgressStageResult,
  type KillActivities,
  type KillEventState,
} from './types.js';

import type {
  EgressControlClient,
  KillEventRepo,
  KillStageAuditSink,
  KillStageMetrics,
} from './ports.js';
import type { KillEgressIdentity, KillEgressOutcome } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';


export interface KillActivityDeps {
  readonly repo: KillEventRepo;
  readonly egress: EgressControlClient;
  readonly audit: KillStageAuditSink;
  readonly metrics: KillStageMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seams; production uses the §8.5 constants. */
  readonly deadlineMs?: number;
  readonly backoffBaseMs?: number;
  readonly maxAttempts?: number;
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
  const { repo, log } = deps;

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
            return { outcome: 'skipped', identities: [], attempts: 0, latencyMs: 0 } satisfies EgressStageResult;
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

    async completeEmptyKill({ tenantId, killEventId }) {
      const event = await requireEvent(repo, tenantId, killEventId);
      if (event.completedAt !== null) return;
      await repo.complete(tenantId, killEventId, {
        status: 'halted',
        completedAt: now(),
        haltMs: 0,
      });
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
      const clean = event.egressBlockedAt !== null && event.status !== 'partially_halted';
      await repo.complete(tenantId, killEventId, {
        status: clean ? 'halted' : 'partially_halted',
        completedAt,
        haltMs: Math.max(0, completedAt.getTime() - event.triggeredAt.getTime()),
      });
      return { completed: true };
    },
  };
}
