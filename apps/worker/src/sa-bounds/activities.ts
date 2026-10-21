import { SpanStatusCode, trace } from '@opentelemetry/api';

import { computeSaTimeline } from './timeline.js';

import type {
  RunEgressBlocker,
  RunLifecycle,
  RunSessionControl,
  SaBoundsAuditSink,
  SaBoundsMetrics,
} from './ports.js';
import type { SaBoundsActivities } from './types.js';
import type { Logger } from '@blackwing/logger';

export interface SaBoundsActivityDeps {
  readonly egress: RunEgressBlocker;
  readonly sessions: RunSessionControl;
  readonly runs: RunLifecycle;
  readonly audit: SaBoundsAuditSink;
  readonly metrics: SaBoundsMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
  /** Per-attempt deadline for the gateway ack; Temporal retries beyond it. */
  readonly blockAttemptMs?: number;
}

/** Longest single timer (6 hours); the workflow re-evaluates at least this often, which also bounds clock skew. */
export const MAX_TIMER_MS = 21_600_000;
const DEFAULT_BLOCK_ATTEMPT_MS = 5_000;
const MS_PER_SECOND = 1_000;

const tracer = trace.getTracer('@blackwing/worker');

/** Builds the SA-bounds activities over their ports. Each one is idempotent. */
export function createSaBoundsActivities(deps: SaBoundsActivityDeps): SaBoundsActivities {
  const now = deps.now ?? ((): Date => new Date());
  const blockAttemptMs = deps.blockAttemptMs ?? DEFAULT_BLOCK_ATTEMPT_MS;
  const { log } = deps;

  return {
    evaluateTimeline(input) {
      const at = now();
      const timeline = computeSaTimeline(input, at);
      const boundary =
        timeline.phase === 'open' ? timeline.closeAt : (timeline.nextOpenAt ?? timeline.expiresAt);
      const untilBoundary =
        boundary === null ? MAX_TIMER_MS : new Date(boundary).getTime() - at.getTime();
      const waitMs = Math.min(MAX_TIMER_MS, Math.max(1, untilBoundary));
      log.info(
        {
          runId: input.runId,
          saId: input.saId,
          expiresAt: timeline.expiresAt,
          windowCloseAt: timeline.closeAt,
          nextOpenAt: timeline.nextOpenAt,
          phase: timeline.phase,
          invalidWindows: timeline.invalidWindows,
        },
        'sa time bounds evaluated',
      );
      if (timeline.invalidWindows > 0) {
        log.warn(
          { runId: input.runId, saId: input.saId, invalidWindows: timeline.invalidWindows },
          'sa test window could not be evaluated; treated as closed',
        );
      }
      return Promise.resolve({ timeline, waitMs });
    },

    async blockEgress({ tenantId, runId, saId, reason, triggerAt }) {
      return tracer.startActiveSpan('sa_bounds.block_and_stop', async (span) => {
        span.setAttribute('run.id', runId);
        span.setAttribute('sa.id', saId);
        span.setAttribute('sa.stop_reason', reason);
        try {
          const outcome = await deps.egress.blockRun(
            { tenantId, runId, reason },
            AbortSignal.timeout(blockAttemptMs),
          );
          const latencyMs = Math.max(0, now().getTime() - new Date(triggerAt).getTime());
          deps.metrics.egressBlockLatency(latencyMs / MS_PER_SECOND);
          log.info({ runId, saId, reason, outcome, latencyMs }, 'egress blocked for run');
          return { outcome, latencyMs };
        } catch (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          log.error({ runId, saId, reason, err }, 'egress block not acknowledged');
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async cancelSessions(ref) {
      await deps.sessions.cancel(ref);
    },

    async pauseSessions(ref) {
      await deps.sessions.pause(ref);
    },

    async resumeSessions(ref) {
      await deps.sessions.resume(ref);
    },

    async finaliseExpired({ tenantId, runId, reason }) {
      await deps.runs.expire({ tenantId, runId }, reason);
      deps.metrics.saExpiry(reason);
      log.info({ runId, reason }, 'run finalised as expired');
    },

    async applyWindowClosed({ tenantId, runId, terminal }) {
      const outcome = await deps.runs.windowClosed({ tenantId, runId }, terminal);
      if (outcome !== 'ignored') {
        deps.metrics.windowTransition(terminal ? 'closed_terminal' : 'closed');
      }
      log.info({ runId, terminal, outcome }, 'test window closed');
      return outcome;
    },

    async applyWindowReopened(ref) {
      const outcome = await deps.runs.windowReopened(ref);
      if (outcome !== 'ignored') deps.metrics.windowTransition('reopened');
      log.info({ runId: ref.runId, outcome }, 'test window reopened');
      return outcome;
    },

    async audit(input) {
      await deps.audit.emit(input);
    },
  };
}
