import { trace } from '@opentelemetry/api';
import { and, eq } from 'drizzle-orm';

import { createAuditEmitter, gate2AuditInput, type AuditEventInput } from '@blackwing/audit';
import {
  type BrokerGate2ExceptionRequest,
  type BrokerGate2ExceptionResponse,
  type Gate2Exception,
  type Gate2ExceptionCreate,
  GATE2_ACTION_SUMMARY_MAX,
  GATE2_EXCEPTION_RAISED_SIGNAL,
  executionWorkflowId,
  gate2IdempotencyKeySchema,
  type RunPauseReason,
  runPauseReasonSchema,
  type RunState,
} from '@blackwing/contracts';
import {
  type Database,
  gate2Service,
  runs,
  toAuditSqlTx,
  type TenantTx,
  withTenant,
} from '@blackwing/db';
import { applyTransition, type RunStatus } from '@blackwing/domain';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '@blackwing/errors';
import { type Logger, withContext } from '@blackwing/logger';
import { runWithWorkflowContext } from '@blackwing/telemetry';

import type { BrokerMetrics } from './metrics.js';

/**
 * Gate 2 broker endpoint (GATE2-002, #206): `POST /internal/broker/gate2/exceptions`. The PDP hook defers an
 * out-of-envelope call here; the endpoint persists a `pending` exception, pauses the run as `gate2_pending`, and
 * signals the run workflow. Creation is deterministic and never depends on the model (§8.11).
 *
 * Fail closed: a signal that cannot be delivered answers 5xx after the exception is committed, so the hook keeps
 * the call deferred and retries with the same `Idempotency-Key`. The retry finds the exception (no duplicate) and
 * signals again. Nothing here ever answers as an allow.
 */

const TRACER = 'blackwing.api.broker';
const MS_PER_MINUTE = 60_000;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

/** The run and session a request is bound to. Taken from the run-scoped token, never from the body (§8.6). */
interface Gate2Ref {
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
}

/** A validated request, plus the `Idempotency-Key` the caller sent. */
interface Gate2RaiseCall {
  readonly ref: Gate2Ref;
  readonly body: BrokerGate2ExceptionRequest;
  readonly idempotencyKey: string;
}

/** The endpoint's port: raises one exception for a deferred call. */
export interface Gate2ExceptionPort {
  raise(call: Gate2RaiseCall): Promise<BrokerGate2ExceptionResponse>;
}

/** Creates the exception and pauses the run in one tenant transaction (`createPostgresGate2Store`). */
export interface Gate2RaiseStore {
  raise(
    ref: { readonly tenantId: string; readonly runId: string },
    create: Gate2ExceptionCreate,
  ): Promise<{ readonly exception: Gate2Exception; readonly created: boolean }>;
}

/** Delivers the "exception raised" signal to the run's workflow (`createTemporalGate2Signaler`). */
export interface Gate2RunSignaler {
  signalRaised(
    ref: { readonly tenantId: string; readonly runId: string },
    exceptionId: string,
  ): Promise<void>;
}

export interface Gate2PortOptions {
  readonly store: Gate2RaiseStore;
  readonly signaler: Gate2RunSignaler;
  /** `gate2_timeout_minutes`: no decision by then is a denial (F13). */
  readonly timeoutMinutes: number;
  readonly metrics: Pick<BrokerMetrics, 'gate2Created' | 'gate2CreateLatency'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** Cuts `text` to at most `max` UTF-8 bytes on a character boundary. */
export function truncateSummary(
  text: string,
  max: number = GATE2_ACTION_SUMMARY_MAX,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return { text, truncated: false };
  let end = max;
  // The first excluded byte is a continuation byte: the cut would split a character, so step back to its start.
  while (end > 0 && ((bytes[end] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** The `Idempotency-Key` header: required, printable ASCII, at most 255 characters (§9). */
export function idempotencyKeyFromHeader(raw: string | readonly string[] | undefined): string {
  const value = typeof raw === 'string' ? raw : raw?.[0];
  const parsed = gate2IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', {
      detail: 'Send one Idempotency-Key of 1 to 255 printable ASCII characters without spaces.',
    });
  }
  return parsed.data;
}

/** Shapes the request into the exception the service persists: the summary truncated, the timeout computed here. */
function toCreate(call: Gate2RaiseCall, timeoutAt: Date): Gate2ExceptionCreate {
  const summary = truncateSummary(call.body.proposedActionSummary);
  return {
    runId: call.ref.runId,
    sessionId: call.body.sessionId,
    subtaskId: call.body.subtaskId ?? null,
    testCaseId: call.body.testCaseId ?? null,
    toolName: call.body.toolName,
    proposedAction: { summary: summary.text, truncated: summary.truncated },
    envelopeReason: call.body.envelopeReason,
    intrusiveness: call.body.intrusiveness,
    batch: call.body.batch,
    timeoutAt: timeoutAt.toISOString(),
    idempotencyKey: call.idempotencyKey,
  };
}

/** Builds the endpoint's port over a store and a signaler. The timeout is computed from the server clock. */
export function createGate2ExceptionPort(options: Gate2PortOptions): Gate2ExceptionPort {
  const now = options.now ?? Date.now;
  const tracer = trace.getTracer(TRACER);
  return {
    raise(call) {
      const started = now();
      return tracer.startActiveSpan('broker.gate2.create', async (span) => {
        try {
          if (call.body.sessionId !== call.ref.sessionId) {
            // A session may only raise for itself: a body naming another session is refused, not trusted.
            throw new ForbiddenError('run mismatch', {
              detail: 'This request is not permitted for the presented run token.',
            });
          }
          const timeoutAt = new Date(started + options.timeoutMinutes * MS_PER_MINUTE);
          const ref = { tenantId: call.ref.tenantId, runId: call.ref.runId };
          const { exception, created } = await options.store.raise(ref, toCreate(call, timeoutAt));
          // Signalled on every attempt, created or replayed: a retry after a lost signal is how the workflow learns.
          await tracer.startActiveSpan('temporal.signal', async (signalSpan) => {
            try {
              await options.signaler.signalRaised(ref, exception.id);
            } catch (error) {
              signalSpan.recordException(
                error instanceof Error ? error : new Error('signal failed'),
              );
              withContext(options.logger, { tenantId: ref.tenantId, runId: ref.runId }).error(
                { event: 'broker.gate2.signal_failed', exceptionId: exception.id },
                'gate2 exception raised but the run workflow could not be signalled',
              );
              throw new AppError(
                'TEMPORAL_UNAVAILABLE',
                'the run workflow could not be signalled',
                {
                  cause: error,
                },
              );
            } finally {
              signalSpan.end();
            }
          });
          if (created) options.metrics.gate2Created.inc({ batch: String(call.body.batch) });
          return { exceptionId: exception.id, state: exception.state };
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error('gate2 create failed'));
          throw error;
        } finally {
          options.metrics.gate2CreateLatency.observe(now() - started);
          span.end();
        }
      });
    },
  };
}

/** The run row fields the pause reads. */
interface RunRow {
  readonly id: string;
  readonly state: string;
  readonly stateVersion: number;
  readonly pauseReason: string | null;
  readonly resumeTo: string | null;
}

/**
 * The run's state-machine status as the row stores it. A `paused` row without its reason or resume target is
 * corrupt: refused, never guessed (fail closed).
 */
export function runStatusOf(row: RunRow): RunStatus {
  if (row.state !== 'paused') {
    return { state: row.state as Exclude<RunState, 'paused'>, version: row.stateVersion };
  }
  const reason = runPauseReasonSchema.safeParse(row.pauseReason);
  if (!reason.success) {
    throw new ConflictError('run pause state is inconsistent', {
      detail: 'The pause reason is missing.',
    });
  }
  if (row.resumeTo !== 'executing') {
    throw new ConflictError('run pause state is inconsistent', {
      detail: 'The resume target is missing.',
    });
  }
  const paused: RunPauseReason = reason.data;
  return { state: 'paused', reason: paused, resumeTo: row.resumeTo, version: row.stateVersion };
}

/**
 * Pauses the run for a Gate 2 exception, through the run state machine (§3.3), in the caller's transaction. The
 * state write is compare-and-set on `state_version`, and the transition is audited as `run.state_changed`. A run
 * that cannot pause (not executing) refuses the transition, which rolls the exception back with it.
 */
export async function pauseRunForGate2(
  tx: TenantTx,
  runId: string,
  tenantId: string,
): Promise<void> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (row === undefined) throw new NotFoundError('run not found');
  const current = runStatusOf(row);
  const result = applyTransition(
    current,
    { type: 'pause', reason: 'gate2_pending' },
    { actor: { kind: 'system', id: 'gate2-broker' } },
  );
  // A repeat pause of an already paused run is the machine's own no-op: nothing to write, nothing to audit.
  if (result.auditIntent === null) return;
  const saved = await tx
    .update(runs)
    .set({
      state: result.next.state,
      pauseReason: result.next.state === 'paused' ? result.next.reason : null,
      resumeTo: result.next.state === 'paused' ? result.next.resumeTo : null,
      stateVersion: result.next.version,
    })
    .where(and(eq(runs.id, runId), eq(runs.stateVersion, row.stateVersion)))
    .returning({ id: runs.id });
  if (saved.length === 0) {
    throw new ConflictError('run state changed concurrently', { detail: 'retry' });
  }
  const audit: AuditEventInput = {
    action: 'run.state_changed',
    tenantId,
    actor: { type: 'system' },
    target: { type: 'run', id: runId },
    runId,
    outcome: 'success',
    reason: 'gate2_pending',
    metadata: { event: result.auditIntent.eventType, from: result.auditIntent.from, to: 'paused' },
    dedupeKey: `run:${runId}:v${result.next.version}:gate2_pause`,
  };
  await createAuditEmitter().emitAuditInTx(toAuditSqlTx(tx), audit);
}

/**
 * The Postgres store (GATE2-002): one `withTenant` transaction holds the exception (and its `gate_decisions` row
 * and audit event, via `gate2Service`) and the run pause. Both commit or neither does.
 */
export function createPostgresGate2Store(db: Database): Gate2RaiseStore {
  const emitter = createAuditEmitter();
  return {
    raise(ref, create) {
      return withTenant(db, ref.tenantId, async (tx) => {
        const service = gate2Service(tx, {
          audit: async (inTx, event) => {
            await emitter.emitAuditInTx(toAuditSqlTx(inTx), gate2AuditInput(event));
          },
        });
        const result = await service.create(create);
        if (result.created) await pauseRunForGate2(tx, ref.runId, ref.tenantId);
        return result;
      });
    },
  };
}

/** The workflow client surface the signaler needs: a signal to one workflow id. */
export interface Gate2SignalClient {
  signal(workflowId: string, signalName: string, arg: unknown): Promise<void>;
}

/** Signals the run's execution workflow (`executionWorkflowId`) within the run's tenant context (§8.6). */
export function createTemporalGate2Signaler(client: Gate2SignalClient): Gate2RunSignaler {
  return {
    signalRaised(ref, exceptionId) {
      return runWithWorkflowContext({ tenantId: ref.tenantId }, () =>
        client.signal(executionWorkflowId(ref.runId), GATE2_EXCEPTION_RAISED_SIGNAL, {
          exceptionId,
        }),
      );
    },
  };
}
