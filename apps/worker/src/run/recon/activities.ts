import { SpanStatusCode, trace } from '@opentelemetry/api';

import { resolveReconManifest } from '@blackwing/domain';

import type { ReconAuditSink, ReconMetrics, ReconRunRepo, SurfaceReader } from './ports.js';
import type { ReconActivities, ReconRef } from './types.js';
import type { Logger } from '@blackwing/logger';

export interface ReconActivityDeps {
  readonly repo: ReconRunRepo;
  readonly surface: SurfaceReader;
  readonly audit: ReconAuditSink;
  readonly metrics: ReconMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
}

const tracer = trace.getTracer('@blackwing/worker');
const MS_PER_SECOND = 1000;

/** Wraps one activity in a span; a thrown error is recorded and rethrown for the Temporal retry. */
async function spanned<T>(name: string, ref: ReconRef, body: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttribute('run.id', ref.runId);
    try {
      return await body();
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Builds the recon activities over their ports (ORCH-004). Definitive answers (run missing, run not in
 * `recon`, empty surface) are returned as values and never retried; only a port that cannot answer
 * throws. The surface model is untrusted data: it is counted, never executed or echoed into audit.
 */
export function createReconActivities(deps: ReconActivityDeps): ReconActivities {
  const now = deps.now ?? ((): Date => new Date());
  const record = (
    ref: ReconRef,
    action: Parameters<ReconAuditSink['append']>[0]['action'],
    outcome: 'success' | 'failure',
    dedupeSuffix: string,
    metadata: Parameters<ReconAuditSink['append']>[0]['metadata'],
  ): Promise<void> =>
    deps.audit.append({
      action,
      outcome,
      tenantId: ref.tenantId,
      runId: ref.runId,
      occurredAt: now().toISOString(),
      dedupeKey: `${ref.runId}:${action}:${dedupeSuffix}`,
      metadata,
    });

  return {
    startRecon: (ref) =>
      spanned('recon.start', ref, async () => {
        const facts = await deps.repo.load(ref.tenantId, ref.runId);
        if (facts === null) return { ok: false, code: 'RUN_NOT_FOUND' } as const;
        if (facts.state !== 'recon') return { ok: false, code: 'RUN_NOT_IN_RECON' } as const;

        const manifest = resolveReconManifest(facts.mode, facts.budgets, {
          manifestSupplied: facts.manifestSuppliesSurface,
        });
        for (const warning of manifest.warnings) {
          deps.log.warn({ runId: ref.runId, mode: facts.mode, warning }, 'recon manifest fallback');
        }
        await record(ref, 'recon.started', 'success', 'run', {
          mode: facts.mode,
          personas: manifest.entries.map((e) => e.persona).join(','),
          warnings: manifest.warnings.join(','),
        });
        deps.log.info(
          { runId: ref.runId, mode: facts.mode, sessions: manifest.entries.length },
          'recon started',
        );
        return {
          ok: true,
          reconCostCapUsd: manifest.reconBudget.costCapUsd,
          warnings: manifest.warnings,
          sessions: manifest.entries.map((e) => ({
            tenantId: ref.tenantId,
            runId: ref.runId,
            phase: 'recon',
            persona: e.persona,
            mode: facts.mode,
            intrusiveness: e.intrusiveness,
            minimal: e.minimal,
            budget: e.budget,
          })),
        } as const;
      }),

    recordSessionStarted: (input) =>
      spanned(`recon.session.started`, input, async () => {
        await record(input, 'recon.session.started', 'success', input.persona, {
          persona: input.persona,
          sessionId: input.sessionId,
        });
        deps.log.info(
          { runId: input.runId, persona: input.persona, sessionId: input.sessionId },
          'recon session started',
        );
      }),

    recordSessionFinished: (input) =>
      spanned(`recon.session.finished`, input, async () => {
        const ok = input.outcome === 'completed';
        await record(input, 'recon.session.finished', ok ? 'success' : 'failure', input.persona, {
          persona: input.persona,
          sessionId: input.sessionId,
          status: input.outcome,
          costUsd: input.costUsd,
        });
        deps.metrics.session(input.persona, input.mode, input.outcome);
        deps.log.info(
          {
            runId: input.runId,
            persona: input.persona,
            sessionId: input.sessionId,
            status: input.outcome,
          },
          'recon session finished',
        );
      }),

    finaliseSurfaceModel: (ref) =>
      spanned('recon.finalise_surface', ref, async () => {
        // A failed read throws: Temporal retries it, and the phase never completes on a guess.
        const [facts, counts] = await Promise.all([
          deps.repo.load(ref.tenantId, ref.runId),
          deps.surface.count(ref.tenantId, ref.runId),
        ]);
        const supplied = facts !== null && facts.mode !== 'black' && facts.manifestSuppliesSurface;
        if (counts.hosts + counts.endpoints === 0 && !supplied) {
          return { ok: false, code: 'RECON_EMPTY_SURFACE' } as const;
        }
        return { ok: true, ...counts, supplied } as const;
      }),

    completeRecon: (input) =>
      spanned('recon.complete', input, async () => {
        const durationMs = Math.max(0, now().getTime() - input.startedAtMs);
        const failed = input.sessions.filter((s) => s.outcome !== 'completed');
        await record(
          input,
          'recon.completed',
          input.outcome === 'completed' ? 'success' : 'failure',
          'run',
          {
            result: input.outcome,
            code: input.code ?? null,
            sessions: input.sessions.length,
            sessionsNotCompleted: failed.length,
            durationMs,
          },
        );
        deps.metrics.duration(durationMs / MS_PER_SECOND);
        deps.log.info(
          { runId: input.runId, result: input.outcome, code: input.code },
          'recon completed',
        );
      }),
  };
}
