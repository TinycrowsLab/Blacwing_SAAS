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
  type Gate1SubmitResponse,
  type RunEnvelope,
} from '@blackwing/contracts';
import {
  applyTransition,
  buildRunEnvelope,
  hasPermission,
  IllegalRunEventError,
  type RunEvent,
  type RunStatus,
  type SignedRunEnvelope,
  signRunEnvelope,
} from '@blackwing/domain';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  TenantContextMissingError,
  ValidationError,
} from '@blackwing/errors';
import { type Clock, systemClock } from '@blackwing/time';

import { Gate1Error } from './errors.js';
import { TRACER_NAME } from '../bootstrap/request-context.js';

import type {
  Gate1AuditRecord,
  Gate1AuditSink,
  Gate1EnvelopeSigner,
  Gate1PinnedEnvelope,
  Gate1Plan,
  Gate1PlanValidator,
  Gate1PolicyEngine,
  Gate1Principal,
  Gate1RunRecord,
  Gate1Signaler,
  Gate1Store,
  Gate1WorkflowSignal,
} from './ports.js';

/** Span of one Gate 1 decision (traces, CONTEXT_PACK §10). */
const GATE1_DECISION_SPAN = 'gate1.decision';
/** Span of building and signing the run envelope of an approval (#399). */
const ENVELOPE_SIGN_SPAN = 'envelope.sign';

/** Run envelope signing metrics (#399): `envelope_sign_total{result}`, `ok` signed, `error` refused or signer failed. */
const noopEnvelopeMetrics: { sign(result: 'ok' | 'error'): void } = { sign: () => undefined };

/** Which run event each decision drives in the run state machine (§3.3). */
const EVENT_FOR_DECISION: Readonly<Record<Gate1Decision, RunEvent>> = {
  approve: { type: 'gate1_approved' },
  request_changes: { type: 'gate1_replan' },
  reject: { type: 'gate1_rejected' },
};

/** The audit action a recorded decision writes: one event per Gate 1 outcome (#398, §8.8). */
const AUDIT_ACTION_FOR_DECISION: Readonly<Record<Gate1Decision, Gate1AuditRecord['action']>> = {
  approve: 'gate1.approved',
  request_changes: 'gate1.changes_requested',
  reject: 'gate1.rejected',
};

export interface Gate1ServiceDeps {
  readonly store: Gate1Store;
  readonly audit: Gate1AuditSink;
  /** PLAN-006 validation of the plan version a submit names. */
  readonly validator: Gate1PlanValidator;
  /** Signals the run's workflow; a decision is recorded only once Temporal acknowledges the signal. */
  readonly signaler: Gate1Signaler;
  /** The Cedar copy of the separation-of-duties rule, checked after RBAC and the service check (§8.4). */
  readonly policy: Gate1PolicyEngine;
  /** Signs the approved run envelope (#399). Required: an approval cannot be released without its envelope. */
  readonly signer: Gate1EnvelopeSigner;
  readonly clock?: Clock;
  /** `envelope_sign_total{result}` (#399); a no-op when omitted. */
  readonly envelopeMetrics?: { sign(result: 'ok' | 'error'): void };
}

export interface Gate1SubmitInput {
  readonly principal: Gate1Principal;
  /** Public run id from the path. */
  readonly runId: string;
  readonly traceId: string | null;
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
  private readonly validator: Gate1PlanValidator;
  private readonly signaler: Gate1Signaler;
  private readonly policy: Gate1PolicyEngine;
  private readonly signer: Gate1EnvelopeSigner;
  private readonly envelopeMetrics: { sign(result: 'ok' | 'error'): void };
  private readonly clock: Clock;
  private readonly tracer = trace.getTracer(TRACER_NAME);

  constructor(deps: Gate1ServiceDeps) {
    this.store = deps.store;
    this.audit = deps.audit;
    this.validator = deps.validator;
    this.signaler = deps.signaler;
    this.policy = deps.policy;
    this.signer = deps.signer;
    this.envelopeMetrics = deps.envelopeMetrics ?? noopEnvelopeMetrics;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Submit-for-Gate-1: validates the run's current plan (PLAN-006), then moves the run `planning` to
   * `awaiting_gate1`, records the submitter as the requester and signals the workflow. The signal goes first: if the
   * workflow does not acknowledge it, nothing is recorded and the submitter retries (`TEMPORAL_UNAVAILABLE`).
   * Requires `testplan:edit`. An invalid plan is `GATE1_PLAN_INVALID` (422) and never reaches the approver.
   */
  async submit(input: Gate1SubmitInput): Promise<Gate1SubmitResponse> {
    const { principal, traceId } = input;
    const tenantId = requireTenant(principal);
    const runId = parseRunId(input.runId);
    const audit = (
      outcome: 'denied' | 'success' | 'failure',
      metadata: Record<string, string | number | boolean | null>,
    ) =>
      this.recordAudit({
        tenantId,
        principal,
        runId,
        action: 'gate1.submitted',
        outcome,
        metadata,
        traceId,
      });

    if (!hasPermission(principal.roles, 'testplan:edit')) {
      await audit('denied', { code: 'FORBIDDEN' });
      throw new ForbiddenError('the caller may not submit test plans', {
        detail: 'Submitting a test plan for Gate 1 needs testplan:edit.',
      });
    }
    const run = await this.store.getRun(tenantId, runId);
    if (run === null) throw notFound();
    // Only a `planning` run can be submitted; any other state is an illegal transition (§3.3, 409).
    if (run.state !== 'planning') throw new IllegalRunEventError(run.state, 'plan_proposed');
    const now = this.clock.now();
    const next = applyTransition(
      { state: 'planning', version: run.stateVersion },
      { type: 'plan_proposed' },
      { actor: { kind: 'user', id: principal.id } },
    ).next;
    const verdict = await this.validator.validate(tenantId, run.id, run.plan.planVersion);
    if (!verdict.valid) {
      await audit('denied', { code: 'GATE1_PLAN_INVALID', planVersion: run.plan.planVersion });
      throw new Gate1Error(
        'GATE1_PLAN_INVALID',
        verdict.violations.length === 0
          ? 'The test plan did not pass validation.'
          : verdict.violations.join('; '),
      );
    }

    await this.signalWorkflow(tenantId, run.id, {
      kind: 'plan_submitted',
      actorId: principal.id,
      planVersion: run.plan.planVersion,
    });
    const outcome = await this.store.submit({
      tenantId,
      runId: run.id,
      expectedStateVersion: run.stateVersion,
      expectedPlanVersion: run.plan.planVersion,
      submittedBy: principal.id,
      nextStateVersion: next.version,
    });
    switch (outcome.kind) {
      case 'submitted':
        await audit('success', {
          planVersion: run.plan.planVersion,
          fromState: 'planning',
          toState: 'awaiting_gate1',
        });
        return {
          runId: run.id,
          planVersion: run.plan.planVersion,
          runState: 'awaiting_gate1',
          submittedAt: now.toISOString(),
        };
      case 'not_found':
        throw notFound();
      case 'not_planning':
        throw new IllegalRunEventError(outcome.state, 'plan_proposed');
      case 'version_conflict':
        throw new Gate1Error('GATE1_NOT_PENDING', 'The run changed while it was being submitted.');
      case 'plan_stale':
        await audit('denied', { code: 'GATE1_PLAN_STALE', planVersion: outcome.planVersion });
        throw new Gate1Error(
          'GATE1_PLAN_STALE',
          `The plan is now version ${String(outcome.planVersion)}; reload it before submitting.`,
        );
    }
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
    ) =>
      this.recordAudit({
        tenantId,
        principal,
        runId,
        action: 'gate1.decided',
        outcome,
        metadata,
        traceId,
      });

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

    // The Cedar copy of separation of duties and tenant isolation (§8.4): it must agree with the check above.
    if (
      this.policy.authorize({
        principal: { id: principal.id, tenantId, canApprove: true },
        resource: { runId: run.id, tenantId, requesterId: run.requesterId },
      }) !== 'allow'
    ) {
      await audit('denied', { code: 'FORBIDDEN', decision: request.decision });
      throw new ForbiddenError('the caller may not decide this test plan', {
        detail: 'The Gate 1 policy refused the decision.',
      });
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
    // An approval signs the run envelope before anything is recorded. If the signer or the envelope is refused, the
    // approval is refused and nothing is signalled or written, so no run can start without its signed envelope (§8.1).
    let sealed: SignedRunEnvelope | null = null;
    if (request.decision === 'approve') {
      try {
        sealed = await this.sealEnvelope(run, tenantId, principal.id, now);
      } catch (error) {
        await audit('denied', { code: errorCodeOf(error), decision: request.decision });
        throw error;
      }
    }
    const pinned = sealed === null ? null : pinnedOf(sealed);
    // Signal first: a decision is recorded only after the workflow acknowledges it, so a lost signal is retried with
    // the same Idempotency-Key and is never left recorded but unapplied.
    await this.signalWorkflow(
      tenantId,
      run.id,
      signalFor(request, principal.id, run.plan.planVersion),
    );
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
      ...(pinned === null ? {} : { envelope: pinned }),
    });

    switch (outcome.kind) {
      case 'decided':
        await this.recordAudit({
          tenantId,
          principal,
          runId: run.id,
          action: AUDIT_ACTION_FOR_DECISION[request.decision],
          outcome: 'success',
          metadata: {
            decision: request.decision,
            planVersion: run.plan.planVersion,
            fromState: 'awaiting_gate1',
            toState: next.state,
            reasonProvided: request.reason !== undefined,
          },
          traceId,
        });
        if (sealed !== null) {
          await this.recordAudit({
            tenantId,
            principal,
            runId: run.id,
            action: 'run.envelope_signed',
            outcome: 'success',
            metadata: {
              envelopeHash: sealed.envelopeHash,
              saId: sealed.envelope.saId,
              signingKeyId: sealed.signingKeyId,
              envelopeVersion: sealed.envelope.envelopeVersion,
              planVersion: run.plan.planVersion,
            },
            traceId,
          });
        }
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

  /**
   * Builds the run envelope from the run and its standing authorisation, and signs it with the tenant signing key.
   * The envelope is refused (not signed) when the SA has expired, the window has closed or the body is over its
   * cap. A signer that cannot answer is `AUTHZ_SIGNER_UNAVAILABLE` (503, retryable): the approval stays pending.
   */
  private async sealEnvelope(
    run: Gate1RunRecord,
    tenantId: string,
    approverId: string,
    now: Date,
  ): Promise<SignedRunEnvelope> {
    const span = this.tracer.startSpan(ENVELOPE_SIGN_SPAN);
    span.setAttribute('run.id', run.id);
    try {
      const authorisation = run.authorisation;
      if (authorisation === null || authorisation === undefined) {
        throw new AppError(
          'ENVELOPE_VERIFICATION_FAILED',
          'the run has no standing authorisation to approve under',
          { detail: 'Approval needs a standing authorisation to sign the run envelope.' },
        );
      }
      const draft: RunEnvelope = {
        runId: run.id,
        tenantId,
        ...authorisation,
        approvedTestCaseIds: run.plan.testCases.map((testCase) => testCase.id),
        approverId,
        approvedPlanVersion: run.plan.planVersion,
        approvedAt: now.toISOString(),
        envelopeVersion: (run.pinnedEnvelope?.envelopeVersion ?? 0) + 1,
      };
      const envelope = buildRunEnvelope(draft, now);
      let sealed: SignedRunEnvelope;
      try {
        sealed = await signRunEnvelope(envelope, await this.signer.envelopeSigningKey());
      } catch (cause) {
        if (cause instanceof AppError) throw cause;
        throw new AppError(
          'AUTHZ_SIGNER_UNAVAILABLE',
          'the signing key service is unavailable; nothing was approved',
          { cause, detail: 'The run envelope could not be signed. Retry the approval.' },
        );
      }
      span.setAttribute('envelope.hash', sealed.envelopeHash);
      this.envelopeMetrics.sign('ok');
      return sealed;
    } catch (error) {
      this.envelopeMetrics.sign('error');
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  private async signalWorkflow(
    tenantId: string,
    runId: string,
    signal: Gate1WorkflowSignal,
  ): Promise<void> {
    try {
      await this.signaler.send(tenantId, runId, signal);
    } catch (error) {
      throw new AppError(
        'TEMPORAL_UNAVAILABLE',
        'The run workflow did not acknowledge the signal; nothing was recorded. Retry.',
        { cause: error },
      );
    }
  }

  private async recordAudit(input: {
    readonly tenantId: string;
    readonly principal: Gate1Principal;
    readonly runId: string;
    readonly action: Gate1AuditRecord['action'];
    readonly outcome: 'denied' | 'success' | 'failure';
    readonly metadata: Record<string, string | number | boolean | null>;
    readonly traceId: string | null;
  }): Promise<void> {
    await this.audit.append({
      action: input.action,
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

function pinnedOf(sealed: SignedRunEnvelope): Gate1PinnedEnvelope {
  return {
    jws: sealed.jws,
    envelopeHash: sealed.envelopeHash,
    signingKeyId: sealed.signingKeyId,
    envelopeVersion: sealed.envelope.envelopeVersion,
    saId: sealed.envelope.saId,
  };
}

/** The stable code of a refusal, or `INTERNAL` for an unexpected failure (never the raw message). */
function errorCodeOf(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL';
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

/**
 * The workflow message for a decision. Approval is `approved`; request changes and rejection are `rejected` with the
 * next step (`replan` or `cancel`). Both rejections carry the reason, which the workflow schema requires.
 */
function signalFor(
  request: Gate1DecisionRequest,
  actorId: string,
  planVersion: number,
): Gate1WorkflowSignal {
  if (request.decision === 'approve') {
    return {
      kind: 'decided',
      decision: 'approved',
      actorId,
      planVersion,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    };
  }
  if (request.reason === undefined) {
    throw new ValidationError('a rejection needs a reason', {
      detail: 'Request changes and reject need a reason.',
    });
  }
  return {
    kind: 'decided',
    decision: 'rejected',
    next: request.decision === 'reject' ? 'cancel' : 'replan',
    actorId,
    planVersion,
    reason: request.reason,
  };
}
