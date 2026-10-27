import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import { costEntries } from './cost.js';

import type {
  ActivityContextLike,
  AgentSessionRepo,
  CostLedger,
  SessionCoverageManifest,
  EvidenceFlusher,
  SandboxService,
  SessionAlerts,
  SessionAuditSink,
  SessionMetrics,
  SessionRuntime,
  VirtualKeyService,
} from './ports.js';
import type { AgentSessionActivities, RunSessionResult } from './types.js';
import type { Logger } from '@blackwing/logger';

export interface AgentSessionActivityDeps {
  readonly sandboxes: SandboxService;
  readonly keys: VirtualKeyService;
  readonly runtime: SessionRuntime;
  readonly evidence: EvidenceFlusher;
  readonly sessions: AgentSessionRepo;
  readonly cost: CostLedger;
  readonly coverage: SessionCoverageManifest;
  readonly audit: SessionAuditSink;
  readonly alerts: SessionAlerts;
  readonly metrics: SessionMetrics;
  readonly log: Logger;
  /** The current Temporal activity context (production: `Context.current()`). */
  readonly context: () => ActivityContextLike;
  readonly now?: () => number;
}

const MS_PER_SECOND = 1000;

const tracer = trace.getTracer('@blackwing/worker');

const modelUsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative(),
  costUSD: z.number().nonnegative(),
});

// Not strict: the SDK adds fields over time. The free-text `result` is not in the schema, so it is
// dropped here and never reaches workflow history or logs.
const runResultSchema = z.object({
  result: z.object({
    subtype: z.string().min(1),
    is_error: z.boolean().optional(),
    stop_reason: z.string().nullish(),
    session_id: z.string(),
    num_turns: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative(),
    modelUsage: z.record(z.string(), modelUsageSchema),
  }),
  pins: z.strictObject({
    promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sdkVersion: z.string().min(1),
    claudeCodeVersion: z.string().min(1),
  }),
  transcriptKey: z.string().min(1).nullable(),
});

/** Runs `fn` in a span, recording failure on it. */
async function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Builds the activities of `AgentSessionWorkflow` over their ports. Each one is idempotent, so Temporal
 * may retry it. Logs carry ids and counters only: never the virtual key (a `keyRef` is a reference, the
 * `bwk_...` value is resolved inside the runtime transport and the logger redacts that format anyway).
 */
export function createAgentSessionActivities(
  deps: AgentSessionActivityDeps,
): AgentSessionActivities {
  const now = deps.now ?? ((): number => Date.now());
  const { log } = deps;

  return {
    async provisionSandbox(request) {
      const started = now();
      const ctx = deps.context();
      const sandbox = await inSpan('agent_session.provision', () =>
        deps.sandboxes.provision(request, ctx.cancellationSignal),
      );
      deps.metrics.sandboxProvisioned((now() - started) / MS_PER_SECOND);
      log.info(
        { runId: request.runId, persona: request.persona, sandboxId: sandbox.sandboxId },
        'sandbox provisioned',
      );
      return sandbox;
    },

    async issueVirtualKey(request) {
      const issued = await deps.keys.issue(request);
      log.info({ runId: request.runId, keyId: issued.keyId }, 'virtual key issued');
      return issued;
    },

    async recordSessionStart(record) {
      await deps.sessions.start(record);
    },

    async runAgentSession(request) {
      const ctx = deps.context();
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      if (ctx.cancellationSignal.aborted) abort();
      ctx.cancellationSignal.addEventListener('abort', abort, { once: true });
      try {
        const raw = await inSpan('agent_session.run', () =>
          deps.runtime.run(request, controller.signal, (progress) => {
            ctx.heartbeat(progress);
          }),
        );
        // Fail closed: a malformed runtime answer is an activity failure, not a guessed status.
        const parsed: RunSessionResult = runResultSchema.parse(raw);
        log.info(
          {
            runId: request.runId,
            sessionId: parsed.result.session_id,
            persona: request.persona,
            sandboxId: request.sandboxId,
            subtype: parsed.result.subtype,
            num_turns: parsed.result.num_turns,
            total_cost_usd: parsed.result.total_cost_usd,
          },
          'agent session finished',
        );
        return parsed;
      } finally {
        ctx.cancellationSignal.removeEventListener('abort', abort);
      }
    },

    async recordSessionFinish(record) {
      await deps.sessions.finish(record);
      deps.metrics.sessionFinished(record.persona, record.subtype, record.totalCostUsd);
    },

    async recordSessionCost({ result, ...record }) {
      await deps.cost.record(costEntries(record, result));
    },

    async recordDeclinedCoverage(record) {
      await deps.coverage.recordDeclined(record);
    },

    async emitSessionAudit(event) {
      await deps.audit.emit(event);
    },

    async flushEvidence(request) {
      await deps.evidence.flush(request, deps.context().cancellationSignal);
    },

    async revokeVirtualKey(request) {
      await deps.keys.revoke(request);
      log.info({ runId: request.runId, keyId: request.keyId }, 'virtual key revoked');
    },

    async destroySandbox(request) {
      const started = now();
      await inSpan('agent_session.teardown', () =>
        deps.sandboxes.destroy(request, deps.context().cancellationSignal),
      );
      deps.metrics.sandboxTornDown((now() - started) / MS_PER_SECOND);
      log.info({ runId: request.runId, sandboxId: request.sandboxId }, 'sandbox destroyed');
    },

    async reportTeardownFailure(request) {
      log.error(
        { runId: request.runId, kind: request.kind, resourceId: request.resourceId },
        request.kind === 'sandbox' ? 'sandbox.orphaned' : 'virtualkey.revoke_failed',
      );
      await deps.alerts.teardownFailed(request);
      if (request.kind === 'sandbox') await deps.sandboxes.scheduleOrphanTeardown(request);
    },
  };
}
