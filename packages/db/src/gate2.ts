// Gate 2 exception persistence service (GATE2-001, F13, F31, CONTEXT_PACK §3.2 step 8, §7, §8.2-§8.4,
// §8.8). It creates exceptions and records their decisions, in the CALLER'S transaction, so the
// exception, its `gate_decisions` row, the audit event and the caller's own writes commit or roll back
// together. It never opens a connection of its own.
//
// The rules live in `@blackwing/domain` (`applyGate2Event`): default deny, separation of duties, no
// destructive approval, no approval after the timeout. This module adds what needs the database:
//   - the tenant is the transaction's, never a caller value; missing context fails closed
//   - idempotency: the same `(tenant, idempotencyKey)` returns the existing exception, no duplicate
//   - optimistic concurrency: a transition lands only on the `state_version` it read. The loser of a
//     double decision gets `GATE2_ALREADY_DECIDED`; the loser of "timeout vs human" or a supersede is a
//     no-op (`applied: false`), because the first committed decision wins
//   - exactly one `gate_decisions` row and one `gate2.decision.recorded` audit event per terminal
//     transition; the database checks the row at commit, so a bug here cannot skip it
//
// The audit sink is injected because `@blackwing/audit` depends on this package: the caller passes
// `gate2AuditInput` + the emitter (`@blackwing/audit`). A failing sink rejects, rolling the whole
// transaction back: a decision whose audit event cannot be written does not happen (§8.8).

import { and, eq } from 'drizzle-orm';

import {
  type Gate2Decide,
  gate2DecideSchema,
  type Gate2Exception,
  type Gate2ExceptionCreate,
  gate2ExceptionCreateSchema,
  type Gate2State,
  OUTBOX_PAYLOAD_MAX_BYTES,
  outboxPayloadBytes,
} from '@blackwing/contracts';
import {
  applyGate2Event,
  describeGate2Transition,
  type Gate2Actor,
  Gate2AlreadyDecidedError,
  type Gate2AuditIntent,
  type Gate2DecisionRecord,
  type Gate2EventType,
  IllegalGate2TransitionError,
} from '@blackwing/domain';
import { ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { createLogger, type Logger, redactText, withContext } from '@blackwing/logger';

import { drizzleGate2Store, type Gate2Store } from './gate2-store.js';
import { redact } from './outbox.js';
import { gate2Exceptions, type Gate2ExceptionRow } from './schema/gate2.js';

import type { TenantTx } from './with-tenant.js';

/** What the audit sink receives; `gate2AuditInput` in `@blackwing/audit` maps it to a ledger event. */
export type Gate2AuditEvent =
  | {
      readonly action: 'gate2.exception.created';
      readonly tenantId: string;
      readonly exception: Gate2Exception;
    }
  | {
      readonly action: 'gate2.decision.recorded';
      readonly tenantId: string;
      readonly exception: Gate2Exception;
      readonly intent: Gate2AuditIntent;
      readonly decision: Gate2DecisionRecord;
    };

/** Appends one audit event inside `tx`. Must reject on failure: the transaction then rolls back. */
export type Gate2AuditSink = (tx: TenantTx, event: Gate2AuditEvent) => Promise<void>;

/** Counter hooks (OBS wires these to Prometheus; the default is a no-op). */
export interface Gate2Metrics {
  /** `gate2_exceptions_total{state}`: one count per exception created (`pending`) or decided. */
  exception(state: Gate2State): void;
}

const NOOP_METRICS: Gate2Metrics = { exception: () => undefined };

export interface Gate2ServiceOptions {
  readonly audit: Gate2AuditSink;
  readonly metrics?: Gate2Metrics;
  readonly logger?: Logger;
}

/** Result of {@link Gate2Service.create}. */
export interface Gate2CreateResult {
  readonly exception: Gate2Exception;
  /** False when the idempotency key already named an exception: nothing was written. */
  readonly created: boolean;
}

/** A transition request: a person's decision, the timer's timeout or the run's supersede. */
export interface Gate2DecisionRequest {
  readonly exceptionId: string;
  readonly event: Gate2EventType;
  readonly actor: Gate2Actor;
  /** Mandatory for `approve` and `deny`; system events have a default. */
  readonly reason?: string;
  /** The `state_version` the decider saw; a stale value is `GATE2_ALREADY_DECIDED`. */
  readonly expectedStateVersion?: number;
}

/** Result of {@link Gate2Service.decide}. */
export interface Gate2DecideResult {
  /** The exception as it is now (the winner's, when this call lost a system-event race). */
  readonly exception: Gate2Exception;
  /** False when a system event found the exception already decided: first committed wins. */
  readonly applied: boolean;
}

export interface Gate2Service {
  /** Opens a `pending` exception, or returns the one this idempotency key already created. */
  create(input: Gate2ExceptionCreate): Promise<Gate2CreateResult>;
  /** Applies one event through the state machine and records the decision. */
  decide(request: Gate2DecisionRequest): Promise<Gate2DecideResult>;
  /** One exception of the active tenant, or `undefined`. */
  get(id: string): Promise<Gate2Exception | undefined>;
}

const MAX_ISSUES_IN_DETAIL = 5;

/**
 * The `gate_decisions.dedupe_key` of an exception's terminal decision. The key is unique per tenant, so a
 * second terminal row for the same exception cannot be written (exactly one row, §8.8).
 */
function gate2DecisionDedupeKey(exceptionId: string): string {
  return `gate2:${exceptionId}`;
}

/** Zod issues as `path: message` lines. Never includes the offending value. */
function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, MAX_ISSUES_IN_DETAIL)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** The persisted row as the API contract: instants as ISO-8601 UTC. */
export function toGate2Exception(row: Gate2ExceptionRow): Gate2Exception {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    sessionId: row.sessionId,
    subtaskId: row.subtaskId,
    testCaseId: row.testCaseId,
    toolName: row.toolName,
    proposedAction: row.proposedAction,
    envelopeReason: row.envelopeReason,
    intrusiveness: row.intrusiveness,
    batch: row.batch,
    state: row.state,
    stateVersion: row.stateVersion,
    requesterId: row.requesterId,
    planApproverId: row.planApproverId,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    timeoutAt: row.timeoutAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

let defaultLogger: Logger | undefined;

/** The package logger, created on first use so importing this module needs no configuration. */
function packageLogger(): Logger {
  defaultLogger ??= createLogger('@blackwing/db');
  return defaultLogger;
}

/** Builds the service over a store. Tests pass an in-memory store; production uses {@link gate2Service}. */
export function createGate2Service(
  tx: TenantTx,
  store: Gate2Store,
  options: Gate2ServiceOptions,
): Gate2Service {
  const metrics = options.metrics ?? NOOP_METRICS;

  async function create(input: Gate2ExceptionCreate): Promise<Gate2CreateResult> {
    const tenantId = await store.tenantId();
    const parsed = gate2ExceptionCreateSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError('invalid gate2 exception', {
        detail: describeIssues(parsed.error.issues),
      });
    }
    const data = parsed.data;

    // §8.7: the summary is durable and shown to approvers, so secret-looking values are removed here
    // even though producers redact first.
    const proposedAction = redact(data.proposedAction, { count: 0 }) as typeof data.proposedAction;
    if (outboxPayloadBytes(proposedAction) > OUTBOX_PAYLOAD_MAX_BYTES) {
      throw new ValidationError('invalid gate2 exception', {
        detail: `proposedAction: exceeds ${OUTBOX_PAYLOAD_MAX_BYTES} bytes: store a reference to the call, not its body`,
      });
    }
    const timeoutAt = new Date(data.timeoutAt);
    if (timeoutAt.getTime() <= (await store.now()).getTime()) {
      // A timeout in the past would deny at birth and hide a caller defect; refuse it instead.
      throw new ValidationError('invalid gate2 exception', {
        detail: 'timeoutAt: must lie in the future',
      });
    }

    const inserted = await store.insertException({
      id: newId(),
      tenantId,
      runId: data.runId,
      sessionId: data.sessionId,
      subtaskId: data.subtaskId ?? null,
      testCaseId: data.testCaseId ?? null,
      toolName: data.toolName,
      proposedAction,
      envelopeReason: redactText(data.envelopeReason),
      intrusiveness: data.intrusiveness,
      batch: data.batch,
      requesterId: data.requesterId ?? null,
      planApproverId: data.planApproverId ?? null,
      timeoutAt,
      idempotencyKey: data.idempotencyKey,
    });

    if (inserted === undefined) {
      const existing = await store.findByIdempotencyKey(data.idempotencyKey);
      if (existing === undefined) {
        // The conflicting row is invisible to this tenant: not ours to return.
        throw new ConflictError('gate2 idempotency key is unavailable');
      }
      if (existing.runId !== data.runId || existing.toolName !== data.toolName) {
        throw new ConflictError('gate2 idempotency key already names a different exception', {
          detail: 'Reuse an idempotency key only to retry the same exception.',
        });
      }
      return { exception: toGate2Exception(existing), created: false };
    }

    const exception = toGate2Exception(inserted);
    await options.audit(tx, { action: 'gate2.exception.created', tenantId, exception });
    metrics.exception(exception.state);
    withContext(options.logger ?? packageLogger(), { tenantId }).info(
      { runId: exception.runId, exceptionId: exception.id, state: exception.state },
      'gate2.exception.created',
    );
    return { exception, created: true };
  }

  async function decide(request: Gate2DecisionRequest): Promise<Gate2DecideResult> {
    const tenantId = await store.tenantId();
    const shape: Gate2Decide | undefined =
      request.event === 'approve' || request.event === 'deny'
        ? {
            exceptionId: request.exceptionId,
            decision: request.event,
            reason: request.reason ?? '',
            ...(request.expectedStateVersion === undefined
              ? {}
              : { expectedStateVersion: request.expectedStateVersion }),
          }
        : undefined;
    if (shape !== undefined) {
      const parsed = gate2DecideSchema.safeParse(shape);
      if (!parsed.success) {
        throw new ValidationError('invalid gate2 decision', {
          detail: describeIssues(parsed.error.issues),
        });
      }
    }
    const isSystemEvent = request.event === 'time_out' || request.event === 'supersede';
    const reason = request.reason === undefined ? undefined : redactText(request.reason);

    const row = await store.findById(request.exceptionId);
    if (row === undefined) {
      throw new NotFoundError('gate2 exception not found');
    }

    // First committed wins. A person who lost gets the conflict; the timer or the run-kill that lost
    // changes nothing.
    const lost = (current: Gate2ExceptionRow): Gate2DecideResult => {
      if (isSystemEvent) return { exception: toGate2Exception(current), applied: false };
      throw new Gate2AlreadyDecidedError(current.state);
    };
    if (row.state !== 'pending') return lost(row);
    if (
      request.expectedStateVersion !== undefined &&
      request.expectedStateVersion !== row.stateVersion
    ) {
      throw new Gate2AlreadyDecidedError(row.state);
    }

    const result = applyGate2Event(
      {
        state: row.state,
        version: row.stateVersion,
        intrusiveness: row.intrusiveness,
        requesterId: row.requesterId,
        planApproverId: row.planApproverId,
        timeoutAt: row.timeoutAt,
      },
      { type: request.event },
      { actor: request.actor, now: await store.now(), ...(reason === undefined ? {} : { reason }) },
    );

    const updated = await store.transition({
      id: row.id,
      fromVersion: row.stateVersion,
      event: request.event,
      to: result.next.state,
      decidedBy: result.next.decidedBy,
    });
    if (updated === undefined) {
      // Zero rows: someone decided first, or the database clock disagreed with the machine's read.
      const current = await store.findById(row.id);
      if (current === undefined) throw new NotFoundError('gate2 exception not found');
      if (current.state !== 'pending') return lost(current);
      throw new IllegalGate2TransitionError(
        current.state,
        request.event,
        request.event === 'approve'
          ? 'The timeout has elapsed: the exception is denied by default.'
          : 'The timeout has not elapsed yet.',
      );
    }

    await store.insertDecision({
      decisionId: newId(),
      tenantId,
      runId: updated.runId,
      gate: 2,
      kind: 'tool_deferred',
      dedupeKey: gate2DecisionDedupeKey(updated.id),
      subtaskId: updated.subtaskId,
      sessionId: updated.sessionId,
      toolUseId: null,
      summary: `${updated.toolName} (${updated.intrusiveness})`,
      target: null,
      status: result.decision.decision,
      requestedAt: updated.createdAt,
      timeoutAt: updated.timeoutAt,
      decidedBy: result.decision.actorId,
      decidedAt: updated.decidedAt ?? new Date(),
      reason: result.decision.reason,
      auto: result.decision.auto,
    });

    const exception = toGate2Exception(updated);
    await options.audit(tx, {
      action: 'gate2.decision.recorded',
      tenantId,
      exception,
      intent: result.auditIntent,
      decision: result.decision,
    });
    metrics.exception(exception.state);
    withContext(options.logger ?? packageLogger(), { tenantId }).info(
      describeGate2Transition(exception.runId, result.auditIntent),
      'gate2.transition',
    );
    return { exception, applied: true };
  }

  async function get(id: string): Promise<Gate2Exception | undefined> {
    await store.tenantId();
    const row = await store.findById(id);
    return row === undefined ? undefined : toGate2Exception(row);
  }

  return { create, decide, get };
}

/** The database clock inside `tx`: the only "now" the Gate 2 timeout guard trusts (F13). */
export function gate2DatabaseNow(tx: TenantTx): Promise<Date> {
  return drizzleGate2Store(tx).now();
}

/** Ids of the run's exceptions still `pending` in the tenant of `tx` (RLS). */
export async function pendingGate2ExceptionIds(tx: TenantTx, runId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: gate2Exceptions.id })
    .from(gate2Exceptions)
    .where(and(eq(gate2Exceptions.runId, runId), eq(gate2Exceptions.state, 'pending')));
  return rows.map((row) => row.id);
}

/** The Gate 2 service over the transaction `withTenant` hands to its callback. */
export function gate2Service(tx: TenantTx, options: Gate2ServiceOptions): Gate2Service {
  return createGate2Service(tx, drizzleGate2Store(tx), options);
}
