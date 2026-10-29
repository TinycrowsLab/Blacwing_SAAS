import { createHash } from 'node:crypto';

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

import {
  gate1BudgetTotals,
  gate1DecisionRequestSchema,
  gate1RunIdSchema,
  idempotencyKeySchema,
  type Gate1Decision,
  type Gate1DecisionRequest,
  type Gate1DecisionResponse,
  type Gate1PlanView,
  type Gate1PlanChanges,
} from '@blackwing/contracts';
import { applyTransition, hasPermission, type RunEvent, type RunStatus } from '@blackwing/domain';
import {
  ForbiddenError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { type Clock, systemClock } from '@blackwing/time';

import { Gate1Error } from './errors.js';
import { TRACER_NAME } from '../bootstrap/request-context.js';

import type {
  Gate1AuditSink,
  Gate1Plan,
  Gate1Principal,
  Gate1RunRecord,
  Gate1Store,
} from './ports.js';

/** Span of one Gate 1 decision (traces, CONTEXT_PACK §10). */
const GATE1_DECISION_SPAN = 'gate1.decision';

/** Which run event each decision drives in the run state machine (§3.3). */
const EVENT_FOR_DECISION: Readonly<Record<Gate1Decision, RunEvent>> = {
  approve: { type: 'gate1_approved' },
  request_changes: { type: 'gate1_replan' },
  reject: { type: 'gate1_rejected' },
};

export interface Gate1ServiceDeps {
  readonly store: Gate1Store;
  readonly audit: Gate1AuditSink;
  readonly clock?: Clock;
}

export interface Gate1DecideInput {
  readonly principal: Gate1Principal;
  /** Public run id from the path. */
  readonly runId: string;
  /** The raw JSON body; validated here, never trusted. */
  readonly body: unknown;
  /** The raw `Idempotency-Key` header, if the client sent one. */
  readonly idempotencyKey: string | undefined;
  readonly traceId: string | null;
}

/**
 * Gate 1 (test plan approval) service (#877). Authorisation is enforced here and again in the store: the
 * approver needs `testplan:approve`, may not be the requester (§8.4, `SOD_VIOLATION`), and the run must still
 * be awaiting Gate 1 at the plan version the approver reviewed. Every decision and every refusal is audited.
 */
export class Gate1Service {
  private readonly store: Gate1Store;
  private readonly audit: Gate1AuditSink;
  private readonly clock: Clock;
  private readonly tracer = trace.getTracer(TRACER_NAME);

  constructor(deps: Gate1ServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.clock = deps.clock ?? systemClock;
  }

  /** The review screen: the plan, its changes, budget totals and what this caller may do. */
  async getPlan(principal: Gate1Principal, runId: string): Promise<Gate1PlanView> {
    const tenantId = requireTenant(principal);
    const id = parseRunId(runId);
    if (!hasPermission(principal.roles, 'testplan:read')) {
      throw new ForbiddenError('the caller may not read test plans', {
        detail: 'Reading a test plan needs testplan:read.',
      });
    }
    const run = await this.store.getRun(tenantId, id);
    if (run === null) throw notFound();
    const now = this.clock.now();
    const isRequester = isRequesterOf(principal.id, run.requesterId);
    const canDecide =
      hasPermission(principal.roles, 'testplan:approve') &&
      !isRequester &&
      run.state === 'awaiting_gate1' &&
      !isExpired(run.plan, now);
    return {
      runId: run.id,
      runState: run.state,
      planVersion: run.plan.planVersion,
      requesterId: run.requesterId,
      requestedAt: run.plan.requestedAt,
      expiresAt: run.plan.expiresAt,
      testCases: [...run.plan.testCases],
      budgetTotals: gate1BudgetTotals(run.plan.testCases.map((t) => t.budget)),
      changes: changesOf(run),
      viewer: { canDecide, isRequester },
    };
  }

  /** Records one decision, or replays the answer of an earlier request with the same `Idempotency-Key`. */
  async decide(input: Gate1DecideInput): Promise<Gate1DecisionResponse> {
    const span = this.tracer.startSpan(GATE1_DECISION_SPAN);
    try {
      return await this.decideInSpan(input, span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  private async decideInSpan(input: Gate1DecideInput, span: Span): Promise<Gate1DecisionResponse> {
    const { principal, traceId } = input;
    const tenantId = requireTenant(principal);
    const runId = parseRunId(input.runId);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const parsed = gate1DecisionRequestSchema.safeParse(input.body);
    if (!parsed.success) {
      throw new ValidationError('the decision request is invalid', {
        detail: parsed.error.issues.map((issue) => issue.message).join('; '),
      });
    }
    const request = parsed.data;
    span.setAttribute('gate1.decision', request.decision);

    const run = await this.store.getRun(tenantId, runId);
    if (run === null) throw notFound();
    const audit = (
      outcome: 'denied' | 'success' | 'failure',
      metadata: Record<string, string | number | boolean | null>,
    ) => this.recordAudit({ tenantId, principal, runId, outcome, metadata, traceId });

    if (!hasPermission(principal.roles, 'testplan:approve')) {
      await audit('denied', { code: 'FORBIDDEN', decision: request.decision });
      throw new ForbiddenError('the caller may not approve test plans', {
        detail: 'Approving a test plan needs testplan:approve.',
      });
    }
    if (isRequesterOf(principal.id, run.requesterId)) {
      await audit('denied', { code: 'SOD_VIOLATION', decision: request.decision });
      throw new Gate1Error('SOD_VIOLATION', 'The requester cannot approve their own test plan.');
    }

    const fingerprint = fingerprintOf(run.id, request);
    const stored = await this.store.findDecision(tenantId, key);
    if (stored !== null) {
      if (stored.fingerprint !== fingerprint) {
        throw new Gate1Error(
          'IDEMPOTENCY_KEY_MISMATCH',
          'The Idempotency-Key was used with a different decision.',
        );
      }
      return stored.response;
    }

    const now = this.clock.now();
    const refusal = refusalOf(run, request, now);
    if (refusal !== null) {
      await audit('denied', { code: refusal.code, decision: request.decision });
      throw refusal;
    }

    const next = transitionFor(run, request.decision, principal.id);
    const response: Gate1DecisionResponse = {
      runId: run.id,
      decision: request.decision,
      planVersion: run.plan.planVersion,
      runState: next.state,
      decidedAt: now.toISOString(),
    };
    const outcome = await this.store.recordDecision({
      tenantId,
      runId: run.id,
      expectedState: 'awaiting_gate1',
      expectedStateVersion: run.stateVersion,
      expectedPlanVersion: run.plan.planVersion,
      nextState: next.state,
      nextStateVersion: next.version,
      decision: request.decision,
      decidedBy: principal.id,
      reason: request.reason ?? null,
      idempotency: { key, fingerprint },
      response,
    });

    switch (outcome.kind) {
      case 'decided':
        await audit('success', {
          decision: request.decision,
          planVersion: run.plan.planVersion,
          fromState: 'awaiting_gate1',
          toState: next.state,
          reasonProvided: request.reason !== undefined,
        });
        return outcome.response;
      case 'replayed':
        return outcome.response;
      case 'mismatch':
        throw new Gate1Error(
          'IDEMPOTENCY_KEY_MISMATCH',
          'The Idempotency-Key was used with a different decision.',
        );
      case 'not_found':
        throw notFound();
      case 'not_pending':
        await audit('denied', { code: 'GATE1_NOT_PENDING', decision: request.decision });
        throw new Gate1Error('GATE1_NOT_PENDING', `The run is now ${outcome.state}.`);
      case 'plan_stale':
        await audit('denied', { code: 'GATE1_PLAN_STALE', decision: request.decision });
        throw new Gate1Error(
          'GATE1_PLAN_STALE',
          `The plan is now version ${String(outcome.planVersion)}; reload it before deciding.`,
        );
    }
  }

  private async recordAudit(input: {
    readonly tenantId: string;
    readonly principal: Gate1Principal;
    readonly runId: string;
    readonly outcome: 'denied' | 'success' | 'failure';
    readonly metadata: Record<string, string | number | boolean | null>;
    readonly traceId: string | null;
  }): Promise<void> {
    await this.audit.append({
      action: 'gate1.decided',
      severity: input.outcome === 'success' ? 'notice' : 'warning',
      outcome: input.outcome,
      tenantId: input.tenantId,
      actor: { type: 'user', id: input.principal.id },
      target: { type: 'run', id: input.runId },
      occurredAt: this.clock.now().toISOString(),
      traceId: input.traceId,
      metadata: input.metadata,
    });
  }
}

function requireTenant(principal: Gate1Principal): string {
  if (principal.tenantId === null) {
    throw new TenantContextMissingError('no tenant context: refusing the Gate 1 request');
  }
  return principal.tenantId;
}

function parseRunId(runId: string): string {
  const parsed = gate1RunIdSchema.safeParse(runId);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function parseIdempotencyKey(header: string | undefined): string {
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new Gate1Error('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required.');
  }
  return parsed.data;
}

function notFound(): NotFoundError {
  return new NotFoundError('run not found', { detail: 'No such run in this tenant.' });
}

/** §8.4: unknown identities fail closed, so a missing requester counts as the requester. */
function isRequesterOf(userId: string, requesterId: string | null): boolean {
  return requesterId === null || requesterId === userId;
}

function isExpired(plan: Gate1Plan, now: Date): boolean {
  return plan.expiresAt !== null && Date.parse(plan.expiresAt) <= now.getTime();
}

/** Why a decision cannot be recorded now, or `null` when it can. Checked before the atomic write. */
function refusalOf(
  run: Gate1RunRecord,
  request: Gate1DecisionRequest,
  now: Date,
): Gate1Error | null {
  if (run.state !== 'awaiting_gate1') {
    return new Gate1Error('GATE1_NOT_PENDING', `The run is now ${run.state}.`);
  }
  if (isExpired(run.plan, now)) {
    return new Gate1Error('GATE1_EXPIRED', 'The Gate 1 approval window has closed.');
  }
  if (run.plan.planVersion !== request.planVersion) {
    return new Gate1Error(
      'GATE1_PLAN_STALE',
      `The plan is now version ${String(run.plan.planVersion)}; reload it before deciding.`,
    );
  }
  return null;
}

/** The run state machine decides the next state; its SoD guard is a second check on the same rule. */
function transitionFor(run: Gate1RunRecord, decision: Gate1Decision, actorId: string): RunStatus {
  const current: RunStatus = { state: 'awaiting_gate1', version: run.stateVersion };
  // The requester is known here (SoD ran first), so the domain guard sees the same pair of people.
  const requestedBy = run.requesterId ?? undefined;
  return applyTransition(current, EVENT_FOR_DECISION[decision], {
    actor: { kind: 'user', id: actorId },
    ...(requestedBy === undefined ? {} : { requestedBy }),
  }).next;
}

function changesOf(run: Gate1RunRecord): Gate1PlanChanges | null {
  const prior = run.priorPlan;
  if (prior === null) return null;
  const before = new Map(prior.testCases.map((t) => [t.id, t]));
  const after = new Map(run.plan.testCases.map((t) => [t.id, t]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()]
    .filter((id) => {
      const previous = before.get(id);
      return previous !== undefined && JSON.stringify(previous) !== JSON.stringify(after.get(id));
    })
    .sort();
  return { fromVersion: prior.planVersion, added, removed, changed };
}

/** The request fingerprint an idempotent replay must match (the same decision on the same plan version). */
function fingerprintOf(runId: string, request: Gate1DecisionRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([runId, request.decision, request.planVersion, request.reason ?? null]),
      'utf8',
    )
    .digest('hex');
}
