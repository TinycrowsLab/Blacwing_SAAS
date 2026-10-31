import { createHash } from 'node:crypto';

import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import { jcs } from '@blackwing/crypto';
import { createLogger, type Logger } from '@blackwing/logger';

import {
  DEFAULT_DECISION_LOG_POLICY,
  shouldWriteDecisionLog,
  type DecisionLogEntry,
  type DecisionLogPolicy,
  type DecisionLogSink,
} from './decision-log.js';
import {
  createMemoryPolicySetCache,
  getEffectivePolicySet,
  type PolicySetCache,
  type TenantPolicyVersionSource,
} from './effective-set.js';
import { cedarDatetime } from './schema.js';

import type { CedarValueJson } from '@cedar-policy/cedar-wasm/nodejs';

/** A Cedar entity reference supplied by the caller (principal or resource). */
export interface PolicyEntityRef {
  readonly type: string;
  readonly id: string;
  readonly attrs?: Readonly<Record<string, CedarValueJson>>;
  readonly parents?: readonly { readonly type: string; readonly id: string }[];
}

/**
 * One authorisation question. `nowUtc` is an explicit input (ISO-8601 UTC): the engine never reads
 * the clock for a decision, so an expiry check can be replayed from the logged digest and time.
 */
export interface PolicyRequest {
  readonly tenantId: string;
  readonly principal: PolicyEntityRef;
  readonly action: { readonly type: string; readonly id: string };
  readonly resource: PolicyEntityRef;
  readonly context: Readonly<Record<string, CedarValueJson>>;
  readonly nowUtc: string;
  readonly runId?: string;
}

/** The PDP answer. `errored: true` means evaluation failed and the deny is fail-closed. */
export interface PolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly determiningPolicyIds: readonly string[];
  readonly reasons: readonly string[];
  readonly errored: boolean;
  readonly latencyMs: number;
}

export interface PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
  evaluateMany(requests: readonly PolicyRequest[]): readonly PolicyDecision[];
}

export interface PolicyEngineOptions {
  readonly versions: TenantPolicyVersionSource;
  readonly sink: DecisionLogSink;
  readonly cache?: PolicySetCache;
  readonly logPolicy?: DecisionLogPolicy;
  /**
   * Called when a deny cannot be written to the decision log. Wire this to `packages/audit` as the
   * fallback record (§8.8). Without it the failure is still counted and logged.
   */
  readonly escalate?: (entry: DecisionLogEntry, error: unknown) => void;
  /** Which actions escalate a failed deny log write. Defaults to every action (conservative). */
  readonly isSecurityCritical?: (action: string) => boolean;
  readonly logger?: Logger;
  /** Monotonic millisecond clock for latency only; never used for a decision. */
  readonly monotonicMs?: () => number;
}

const TRACER_NAME = '@blackwing/policy';
const meter = metrics.getMeter(TRACER_NAME);
const evalTotal = meter.createCounter('policy_eval_total', {
  description: 'Policy decisions by outcome',
});
const evalLatency = meter.createHistogram('policy_eval_latency_ms', {
  description: 'Policy decision latency in milliseconds',
  unit: 'ms',
});
const cacheLookups = meter.createCounter('policy_eval_cache_lookups_total', {
  description: 'Compiled policy-set cache lookups by result (hit ratio = hit / (hit + miss))',
});
const logWriteFailures = meter.createCounter('policy_decision_log_write_failures_total', {
  description: 'Decision log writes that failed',
});

const ISO_UTC_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

interface Outcome {
  readonly decision: 'allow' | 'deny';
  readonly determiningPolicyIds: readonly string[];
  readonly reasons: readonly string[];
  readonly errored: boolean;
  readonly contextDigest: string;
}

function denyErrored(errors: readonly string[], contextDigest: string): Outcome {
  return {
    decision: 'deny',
    determiningPolicyIds: [],
    reasons: errors,
    errored: true,
    contextDigest,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/** SHA-256 over the canonical (JCS) form of the context. Raw context is never logged. */
function digestContext(context: Readonly<Record<string, CedarValueJson>>): string {
  return createHash('sha256').update(jcs(context), 'utf8').digest('hex');
}

/**
 * Builds the policy decision point (POLICY-004). The engine is deterministic for a fixed effective
 * set and `nowUtc`. It fails closed: a Cedar `deny`, any evaluation, schema or parse error, and any
 * missing or invalid input all yield `deny`. Only a Cedar `allow` with no diagnostics errors is
 * `allow`. Decision-log writes are asynchronous and never block the decision.
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  const cache = options.cache ?? createMemoryPolicySetCache();
  const logPolicy = options.logPolicy ?? DEFAULT_DECISION_LOG_POLICY;
  const clock = options.monotonicMs ?? (() => performance.now());
  // Latency is observability only: a failing clock reads as zero and never changes a decision.
  const elapsedClock = (): number => {
    try {
      return clock();
    } catch {
      return 0;
    }
  };
  const logger = options.logger ?? createLogger('policy');
  const isSecurityCritical = options.isSecurityCritical ?? (() => true);
  const tracer = trace.getTracer(TRACER_NAME);

  function reportLogFailure(entry: DecisionLogEntry, err: unknown): void {
    logWriteFailures.add(1);
    logger.error(
      {
        action: entry.action,
        decision: entry.decision,
        errored: entry.errored,
        err: describe(err),
      },
      'policy decision log write failed',
    );
    if (entry.decision !== 'deny' || !isSecurityCritical(entry.action)) return;
    try {
      options.escalate?.(entry, err);
    } catch (escalateErr) {
      logger.error(
        { action: entry.action, err: describe(escalateErr) },
        'policy escalation failed',
      );
    }
  }

  // Fire-and-forget: the decision never waits on the sink. A sync throw and a rejection share one failure path.
  function writeLog(entry: DecisionLogEntry): void {
    let write: Promise<void>;
    try {
      write = Promise.resolve(options.sink.write(entry));
    } catch (err) {
      reportLogFailure(entry, err);
      return;
    }
    write.catch((err: unknown) => {
      reportLogFailure(entry, err);
    });
  }

  function decide(request: PolicyRequest): Outcome {
    let contextDigest: string;
    try {
      contextDigest = digestContext(request.context);
    } catch (err) {
      return denyErrored([`context is not serialisable: ${describe(err)}`], '');
    }
    if (request.tenantId.trim() === '') return denyErrored(['tenantId is required'], contextDigest);
    if (!ISO_UTC_PREFIX.test(request.nowUtc)) {
      return denyErrored(['nowUtc must be an ISO-8601 UTC instant'], contextDigest);
    }
    if (request.principal.attrs?.tenantId !== request.tenantId) {
      return denyErrored(['principal tenant does not match the request tenant'], contextDigest);
    }
    const effective = getEffectivePolicySet(request.tenantId, options.versions, cache);
    cacheLookups.add(1, { result: effective.ok && effective.cacheHit ? 'hit' : 'miss' });
    if (!effective.ok) {
      logger.error(
        { tenantId: request.tenantId, errors: effective.errors },
        'effective policy set unavailable; denying',
      );
      return denyErrored(effective.errors, contextDigest);
    }

    let nowContext: CedarValueJson;
    try {
      nowContext = cedarDatetime(request.nowUtc);
    } catch (err) {
      return denyErrored([describe(err)], contextDigest);
    }
    const principalUid = { type: request.principal.type, id: request.principal.id };
    const resourceUid = { type: request.resource.type, id: request.resource.id };
    try {
      const answer = cedar.isAuthorized({
        principal: principalUid,
        action: { type: request.action.type, id: request.action.id },
        resource: resourceUid,
        context: { ...request.context, nowUtc: nowContext },
        policies: { staticPolicies: { ...effective.set.staticPolicies } },
        entities: [
          {
            uid: principalUid,
            attrs: { ...(request.principal.attrs ?? {}) },
            parents: [...(request.principal.parents ?? [])],
          },
          {
            uid: resourceUid,
            attrs: { ...(request.resource.attrs ?? {}) },
            parents: [...(request.resource.parents ?? [])],
          },
        ],
      });
      if (answer.type !== 'success') {
        return denyErrored(
          answer.errors.map((e) => e.message),
          contextDigest,
        );
      }
      const { decision, diagnostics } = answer.response;
      // Cedar skips an erroring policy and still answers. For this PDP any error means deny.
      const errors = diagnostics.errors.map((e) => e.error.message);
      if (errors.length > 0) return denyErrored(errors, contextDigest);
      const ids = [...diagnostics.reason];
      if (decision === 'allow') {
        return { decision, determiningPolicyIds: ids, reasons: [], errored: false, contextDigest };
      }
      const reasons = ids.length === 0 ? ['no permit policy matched (default deny)'] : [];
      return { decision, determiningPolicyIds: ids, reasons, errored: false, contextDigest };
    } catch (err) {
      return denyErrored([`cedar evaluation failed: ${describe(err)}`], contextDigest);
    }
  }

  function evaluate(request: PolicyRequest): PolicyDecision {
    const started = elapsedClock();
    return tracer.startActiveSpan('policy.evaluate', (span) => {
      try {
        span.setAttributes({
          action: `${request.action.type}::${request.action.id}`,
          tenantId: request.tenantId,
        });
        let outcome: Outcome;
        try {
          outcome = decide(request);
        } catch (err) {
          // Last-resort guard: a bug in this function must never surface as an allow.
          outcome = denyErrored([`policy evaluation failed: ${describe(err)}`], '');
        }
        const latencyMs = Math.max(0, elapsedClock() - started);
        const decision: PolicyDecision = {
          decision: outcome.decision,
          determiningPolicyIds: outcome.determiningPolicyIds,
          reasons: outcome.reasons,
          errored: outcome.errored,
          latencyMs,
        };
        const action = `${request.action.type}::${request.action.id}`;
        span.setAttributes({ decision: outcome.decision, errored: outcome.errored });
        if (outcome.errored) span.setStatus({ code: SpanStatusCode.ERROR });
        evalTotal.add(1, { decision: outcome.decision, errored: String(outcome.errored) });
        evalLatency.record(latencyMs);
        if (shouldWriteDecisionLog(logPolicy, outcome.decision, outcome.errored)) {
          writeLog({
            tenantId: request.tenantId,
            runId: request.runId,
            action,
            decision: outcome.decision,
            determiningPolicyIds: outcome.determiningPolicyIds,
            errored: outcome.errored,
            latencyMs,
            contextDigest: outcome.contextDigest,
            nowUtc: request.nowUtc,
          });
        }
        return decision;
      } finally {
        span.end();
      }
    });
  }

  return {
    evaluate,
    evaluateMany(requests) {
      return requests.map((request) => evaluate(request));
    },
  };
}
