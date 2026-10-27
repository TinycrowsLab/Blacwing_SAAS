import { createHash } from 'node:crypto';

import { metrics, trace } from '@opentelemetry/api';

import { currentTenantId } from '@blackwing/db/tenant-context';
import { TenantContextMissingError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import {
  auditErrorCode,
  isCancelledError,
  WORKFLOW_AUDIT_ACTIVITY,
  type WorkflowAuditEvent,
} from './audit-shared.js';

import type { AuditEmitter, AuditEventInput } from '@blackwing/audit';
import type { AuditAction, AuditMetadata } from '@blackwing/contracts';
import type { ActivityInterceptorsFactory } from '@temporalio/worker';

/**
 * Temporal audit integration (WORKFLOW-007, CONTEXT_PACK §8.8). Activities write
 * `activity.{started,succeeded,failed}` events and, on behalf of workflow code (which cannot do I/O),
 * `workflow.*` events, all through the transactional outbox behind `emitAudit`. The tenant comes from the
 * tenant activity interceptor (which must wrap this one); a missing tenant rejects.
 */

type AuditSource = 'workflow' | 'activity';

/** `audit_events_emitted_total{source}` and `audit_emit_failures_total`. */
export interface AuditInterceptorMetrics {
  emitted(source: AuditSource): void;
  failed(): void;
}

export interface AuditInterceptorDeps {
  readonly emitter: Pick<AuditEmitter, 'emitAudit'>;
  /** Per activity type sampling rate (`AUDIT_ACTIVITY_SAMPLE`). Unlisted types are always audited. */
  readonly sample?: ReadonlyMap<string, number>;
  /** Types that are never sampled and whose audit failure fails the activity. Defaults to {@link isCriticalActivity}. */
  readonly isCritical?: (activityType: string) => boolean;
  readonly metrics?: AuditInterceptorMetrics;
  readonly log?: Logger;
}

/** Gate, kill and state-changing activities: never sampled, and they fail closed when audit fails. */
const CRITICAL_ACTIVITY = /gate|kill|state[_-]?chang|transition/i;
export const isCriticalActivity = (activityType: string): boolean =>
  CRITICAL_ACTIVITY.test(activityType);

/** Failed non-critical events kept for retry; the oldest is logged and dropped beyond this. */
const MAX_PENDING = 1000;
const MAX_SUMMARY_KEYS = 20;
const MAX_SUMMARY_STRING = 200;
const SAMPLE_BUCKETS = 0x1_0000_0000;
const DEDUPE_KEY = /^[\x21-\x7e]{1,255}$/;

export function createOtelAuditMetrics(): AuditInterceptorMetrics {
  const meter = metrics.getMeter('@blackwing/worker');
  const emitted = meter.createCounter('audit_events_emitted_total', {
    description: 'Audit events handed to the outbox by the Temporal interceptors, by source',
  });
  const failures = meter.createCounter('audit_emit_failures_total', {
    description: 'Audit events the Temporal interceptors failed to write',
  });
  return {
    emitted: (source) => {
      emitted.add(1, { source });
    },
    failed: () => {
      failures.add(1);
    },
  };
}

/** Top-level scalar inputs only, truncated; nested values are replaced by a marker. The emitter redacts too. */
function summariseInput(args: readonly unknown[]): AuditMetadata {
  const [first] = args;
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return {};
  const summary: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(first as Record<string, unknown>).slice(
    0,
    MAX_SUMMARY_KEYS,
  )) {
    if (typeof value === 'string') summary[key] = value.slice(0, MAX_SUMMARY_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) summary[key] = value;
    else if (typeof value === 'boolean' || value === null) summary[key] = value;
    else summary[key] = Array.isArray(value) ? '[array]' : '[object]';
  }
  return summary;
}

function runIdOf(args: readonly unknown[]): string {
  const [first] = args;
  const runId =
    typeof first === 'object' && first !== null ? (first as { runId?: unknown }).runId : undefined;
  if (typeof runId !== 'string' || runId === '') {
    throw new TenantContextMissingError('activity input carries no runId');
  }
  return runId;
}

/** Idempotency key, hashed when Temporal ids would not fit the audit dedupe-key alphabet. */
function dedupeKey(...parts: readonly (string | number)[]): string {
  const key = parts.join(':');
  return DEDUPE_KEY.test(key) ? key : createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Deterministic per attempt, so started/succeeded of one attempt are kept or dropped together. */
function sampledOut(key: string, rate: number | undefined): boolean {
  if (rate === undefined || rate >= 1) return false;
  const bucket = createHash('sha256').update(key, 'utf8').digest().readUInt32BE(0);
  return bucket / SAMPLE_BUCKETS >= rate;
}

function traceId(): string | undefined {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id !== undefined && /^(?!0{32})[0-9a-f]{32}$/.test(id) ? id : undefined;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function baseEvent(
  tenantId: string,
  runId: string,
  action: AuditAction,
  outcome: 'success' | 'failure',
  key: string,
  metadata: AuditMetadata,
  reason?: string,
): AuditEventInput {
  const traceIdValue = traceId();
  return {
    tenantId,
    action,
    actor: { type: 'system', id: 'worker' },
    target: { type: 'run', id: runId },
    outcome,
    metadata,
    dedupeKey: key,
    ...(UUID_V7.test(runId) ? { runId } : {}),
    ...(reason === undefined ? {} : { reason }),
    ...(traceIdValue === undefined ? {} : { traceId: traceIdValue }),
  };
}

interface Sink {
  /** Writes the event; rejects on failure. */
  strict(input: AuditEventInput, source: AuditSource): Promise<void>;
  /** Writes the event; on failure keeps it queued for retry and never throws. */
  lenient(input: AuditEventInput, source: AuditSource): Promise<void>;
}

function createSink(deps: AuditInterceptorDeps): Sink {
  const meter = deps.metrics ?? createOtelAuditMetrics();
  const log = deps.log ?? createLogger('worker-audit');
  const pending: { input: AuditEventInput; source: AuditSource }[] = [];

  async function write(input: AuditEventInput, source: AuditSource): Promise<void> {
    try {
      await deps.emitter.emitAudit(input);
    } catch (error) {
      meter.failed();
      throw error;
    }
    meter.emitted(source);
  }

  async function flush(): Promise<void> {
    while (pending[0] !== undefined) {
      try {
        await write(pending[0].input, pending[0].source);
      } catch {
        return;
      }
      pending.shift();
    }
  }

  return {
    strict: (input, source) => write(input, source),
    async lenient(input, source) {
      await flush();
      try {
        await write(input, source);
      } catch (error) {
        log.error(
          { action: input.action, dedupeKey: input.dedupeKey, code: auditErrorCode(error) },
          'audit emit failed; queued for retry',
        );
        if (pending.length >= MAX_PENDING) {
          const dropped = pending.shift();
          log.error({ dedupeKey: dropped?.input.dedupeKey }, 'audit retry queue full; event lost');
        }
        pending.push({ input, source });
      }
    },
  };
}

/**
 * Activity interceptor: `activity.<started|succeeded|failed>` per attempt. Critical types (gate, kill,
 * state-changing) are never sampled and fail closed when their audit event cannot be written; other types
 * log, count and queue the failed write for retry. Failures are always audited, even when sampled out.
 */
export function createAuditActivityInterceptors(
  deps: AuditInterceptorDeps,
): ActivityInterceptorsFactory {
  const sink = createSink(deps);
  const isCritical = deps.isCritical ?? isCriticalActivity;

  return (ctx) => ({
    inbound: {
      async execute(input, next) {
        const { activityType, activityId, attempt, workflowType, workflowExecution } = ctx.info;
        if (activityType === WORKFLOW_AUDIT_ACTIVITY) return next(input);

        const tenantId = currentTenantId();
        if (tenantId === undefined) throw new TenantContextMissingError('no tenant context');
        const runId = runIdOf(input.args);

        const critical = isCritical(activityType);
        const attemptKey = dedupeKey(runId, activityId, attempt);
        const quiet = !critical && sampledOut(attemptKey, deps.sample?.get(activityType));
        const metadata: AuditMetadata = {
          activityType,
          activityId,
          attempt,
          workflowType,
          workflowId: workflowExecution.workflowId,
          input: summariseInput(input.args),
        };
        const event = (
          action: AuditAction,
          outcome: 'success' | 'failure',
          kind: string,
          extra: AuditMetadata = {},
          reason?: string,
        ): AuditEventInput =>
          baseEvent(
            tenantId,
            runId,
            action,
            outcome,
            dedupeKey(runId, activityId, attempt, kind),
            { ...metadata, ...extra },
            reason,
          );

        if (!quiet) {
          const started = event('activity.started', 'success', 'started');
          await (critical ? sink.strict(started, 'activity') : sink.lenient(started, 'activity'));
        }

        let result: unknown;
        try {
          result = await next(input);
        } catch (error) {
          const cancelled = isCancelledError(error);
          await sink.lenient(
            event(
              'activity.failed',
              'failure',
              'failed',
              { errorCode: cancelled ? 'CANCELLED' : auditErrorCode(error) },
              cancelled ? 'cancelled' : undefined,
            ),
            'activity',
          );
          throw error;
        }
        if (!quiet) {
          const succeeded = event('activity.succeeded', 'success', 'succeeded');
          await (critical
            ? sink.strict(succeeded, 'activity')
            : sink.lenient(succeeded, 'activity'));
        }
        return result;
      },
    },
  });
}

const WORKFLOW_ACTIONS = {
  started: 'workflow.started',
  completed: 'workflow.completed',
  failed: 'workflow.failed',
  cancelled: 'workflow.cancelled',
  continued_as_new: 'workflow.continued_as_new',
} as const satisfies Record<WorkflowAuditEvent['kind'], AuditAction>;

/**
 * The activity workflow code schedules (as a local activity) to record `workflow.*` events: workflow code
 * cannot do I/O, so the intent is written to the outbox here. Always strict: a workflow lifecycle event
 * is never dropped, a failed write fails the local activity and Temporal retries it. The write is
 * idempotent per `(workflow, execution, kind)`.
 */
export function createAuditActivities(deps: AuditInterceptorDeps): {
  readonly [WORKFLOW_AUDIT_ACTIVITY]: (event: WorkflowAuditEvent) => Promise<void>;
} {
  const sink = createSink(deps);
  return {
    async [WORKFLOW_AUDIT_ACTIVITY](event) {
      const tenantId = currentTenantId();
      if (tenantId === undefined) throw new TenantContextMissingError('no tenant context');
      await sink.strict(
        baseEvent(
          tenantId,
          event.runId,
          WORKFLOW_ACTIONS[event.kind],
          event.kind === 'failed' ? 'failure' : 'success',
          dedupeKey('wf', event.runId, event.workflowId, event.executionRunId, event.kind),
          {
            workflowType: event.workflowType,
            workflowId: event.workflowId,
            ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          },
          event.kind === 'cancelled' ? 'cancelled' : undefined,
        ),
        'workflow',
      );
    },
  };
}
