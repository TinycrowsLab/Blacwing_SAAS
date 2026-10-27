import { createHash } from 'node:crypto';

import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  type AuditTarget,
  idempotencyKeySchema,
  isKillOpen,
  type KillEvent,
  killEventSchema,
  killFailedComponents,
  killSlaBreaches,
  type KillTargetSet,
  type KillTriggerResponse,
  type OperatorBlastRadius,
  operatorBlastRadiusQuerySchema,
  type OperatorKillEventDetail,
  operatorKillEventDetailSchema,
  type OperatorKillEventSummary,
  operatorKillEventSummarySchema,
  operatorKillRequestSchema,
  type OperatorKillScope,
  PLATFORM_OPERATOR,
  TERMINAL_RUN_STATES,
  uuidV7Schema,
} from '@blackwing/contracts';
import {
  isKillableRunState,
  type KillRunQuery,
  KILL_RESOLVE_SPAN,
  resolveKillTargets,
} from '@blackwing/domain';
import { AppError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type Clock, systemClock } from '@blackwing/time';

import { OperatorKillError } from './errors.js';
import { KillApiError } from '../kill/errors.js';

import type { OperatorKillMetrics, OperatorKillResult } from './metrics.js';
import type {
  OperatorKillAuditRecord,
  OperatorKillAuditSink,
  OperatorKillEventStore,
  OperatorKillSignaler,
  OperatorKillTargetReaderFactory,
  OperatorPrincipal,
  OperatorTenantDirectory,
} from './ports.js';
import type { Logger } from '@blackwing/logger';
import type { z } from 'zod';

export const OPERATOR_KILL_FIRE_SPAN = 'web.operator.kill.fire';
export const OPERATOR_KILL_PREVIEW_SPAN = 'web.operator.kill.preview';
const TRACER_NAME = '@blackwing/api/operator-kill';
const SOURCE = 'operator';
const GLOBAL_PERMISSION = 'platform:global_kill';
/** Most events `GET /operator/v1/kill/events` returns. */
const EVENT_LIST_LIMIT = 50;
/** Kill events whose halt time was already observed; bounded so a long-lived process cannot grow it. */
const OBSERVED_CAP = 1000;

export interface OperatorKillServiceDeps {
  readonly store: OperatorKillEventStore;
  readonly tenants: OperatorTenantDirectory;
  readonly targets: OperatorKillTargetReaderFactory;
  readonly signaler: OperatorKillSignaler;
  readonly audit: OperatorKillAuditSink;
  readonly logger: Logger;
  readonly metrics: OperatorKillMetrics;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly tracer?: Tracer;
}

export interface OperatorKillFireInput {
  readonly principal: OperatorPrincipal;
  readonly body: unknown;
  /** Raw `Idempotency-Key` header, if any. */
  readonly idempotencyKey: string | undefined;
  readonly traceId: string | null;
}

interface Inspection {
  readonly targets: KillTargetSet;
  /** Tenants that own a killable run in scope; their audit streams record the kill. */
  readonly tenantIds: readonly string[];
}

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function invalid(what: string, error: z.ZodError): ValidationError {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || '(body)'))];
  return new ValidationError(`invalid ${what}`, { detail: `invalid fields: ${fields.join(', ')}` });
}

/** Stable fingerprint of a fire request, to detect an `Idempotency-Key` reused with another body. */
function fingerprintOf(scope: OperatorKillScope, tenantId: string | null, reason: string): string {
  return createHash('sha256')
    .update(JSON.stringify([scope, tenantId, reason]), 'utf8')
    .digest('hex');
}

function toSummary(event: KillEvent): OperatorKillEventSummary {
  return operatorKillEventSummarySchema.parse({
    id: event.id,
    scope: event.scope,
    tenantId: event.tenantId,
    actor: event.actorRef,
    reason: event.reason,
    firedAt: event.triggeredAt,
    haltMs: event.haltMs,
    status: event.status,
  });
}

function toDetail(event: KillEvent): OperatorKillEventDetail {
  return operatorKillEventDetailSchema.parse({
    ...toSummary(event),
    egressBlockedAt: event.egressBlockedAt,
    sandboxesTerminatedAt: event.sandboxesTerminatedAt,
    keysRevokedAt: event.keysRevokedAt,
    workflowsCancelledAt: event.workflowsCancelledAt,
    completedAt: event.completedAt,
    affected: event.affected,
  });
}

/** The partial-kill refusal: names each component that is still running (§8.5, never a false "all stopped"). */
function partialError(event: KillEvent): OperatorKillError {
  const failed = killFailedComponents(event.affected).map((c) => `${c.kind} ${c.id}`);
  return new OperatorKillError(
    'KILL_PARTIAL',
    failed.length === 0
      ? `kill ${event.id} did not stop everything in scope`
      : `kill ${event.id} did not stop: ${failed.join(', ')}`,
  );
}

const isPartial = (event: KillEvent): boolean =>
  event.status === 'partially_halted' || event.status === 'failed';

/**
 * The platform-operator kill control (F33, §1.2, §8.5, §8.11). It previews the blast radius, records
 * the kill, hands the target set to the deterministic kill path and reports what that path measured.
 * It never halts anything itself and never reports success before the path confirms it.
 */
export class OperatorKillService {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly tracer: Tracer;
  private readonly observed = new Set<string>();

  constructor(private readonly deps: OperatorKillServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.nextId = deps.idGenerator ?? newId;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async preview(
    principal: OperatorPrincipal,
    query: unknown,
    traceId: string | null,
  ): Promise<OperatorBlastRadius> {
    return this.inSpan(OPERATOR_KILL_PREVIEW_SPAN, async () => {
      this.requireOperator(principal);
      const parsed = operatorBlastRadiusQuerySchema.safeParse(query);
      if (!parsed.success) throw invalid('blast-radius query', parsed.error);
      const { scope, tenantId = null } = parsed.data;
      const tenantSlug = await this.tenantSlug(tenantId);
      const { targets, tenantIds } = await this.inspect(principal.id, scope, tenantId);
      const radius: OperatorBlastRadius = {
        runsAffected: targets.runIds.length,
        sandboxesAffected: targets.sandboxIds.length,
        tenantsAffected: tenantIds.length,
        sessionsAffected: targets.sessionIds.length,
        ...(tenantSlug === null ? {} : { tenantSlug }),
      };
      await this.writeAudit({
        action: 'operator.kill_previewed',
        severity: 'notice',
        outcome: 'success',
        tenantId: null,
        actor: { type: 'operator', id: principal.id },
        target: targetOf(scope, tenantId),
        occurredAt: this.clock.now().toISOString(),
        traceId,
        metadata: {
          scope,
          tenantId,
          runsAffected: radius.runsAffected,
          sandboxesAffected: radius.sandboxesAffected,
          tenantsAffected: radius.tenantsAffected,
          sessionsAffected: radius.sessionsAffected,
        },
      });
      return radius;
    });
  }

  async fire(input: OperatorKillFireInput): Promise<KillTriggerResponse> {
    return this.inSpan(OPERATOR_KILL_FIRE_SPAN, async (span) => {
      let scope = 'unknown';
      let result: OperatorKillResult = 'error';
      try {
        this.requireOperator(input.principal);
        const response = await this.fireAuthorised(input, span, (s) => {
          scope = s;
        });
        result = 'accepted';
        return response;
      } catch (err) {
        result = resultOf(err);
        throw err;
      } finally {
        this.deps.metrics.fired.inc({ scope, result });
      }
    });
  }

  async list(principal: OperatorPrincipal): Promise<readonly OperatorKillEventSummary[]> {
    this.requireOperator(principal);
    return (await this.deps.store.list(EVENT_LIST_LIMIT)).map((event) => toSummary(event));
  }

  async get(principal: OperatorPrincipal, killEventId: string): Promise<OperatorKillEventDetail> {
    this.requireOperator(principal);
    const event = uuidV7Schema.safeParse(killEventId).success
      ? await this.deps.store.get(killEventId)
      : null;
    if (event?.source !== SOURCE) throw new NotFoundError('kill event not found');
    this.observeHalt(event);
    return toDetail(event);
  }

  private async inSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Platform operators only: a tenant principal, whatever its tenant role, is refused (§1.2). */
  private requireOperator(principal: OperatorPrincipal): void {
    if (principal.role === PLATFORM_OPERATOR && principal.permissions.includes(GLOBAL_PERMISSION)) {
      return;
    }
    this.deps.logger.warn(
      { actorRef: principal.id },
      'operator kill refused: not a platform operator',
    );
    throw new OperatorKillError('NOT_OPERATOR', 'this control is limited to platform operators');
  }

  private async tenantSlug(tenantId: string | null): Promise<string | null> {
    if (tenantId === null) return null;
    const tenant = await this.deps.tenants.get(tenantId);
    if (tenant === null) throw new NotFoundError('tenant not found');
    return tenant.slug;
  }

  /** Everything the kill would stop right now, read on the operator role. */
  private async inspect(
    operatorId: string,
    scope: OperatorKillScope,
    tenantId: string | null,
  ): Promise<Inspection> {
    return this.tracer.startActiveSpan(KILL_RESOLVE_SPAN, async (child) => {
      try {
        return await this.deps.targets.withOperatorReader(operatorId, async (reader) => {
          const query: KillRunQuery =
            scope === 'global' ? { by: 'all' } : { by: 'tenant', tenantId: tenantId ?? '' };
          const runs = (await reader.listRuns(query, TERMINAL_RUN_STATES)).filter(
            (run) =>
              isKillableRunState(run.state) && (tenantId === null || run.tenantId === tenantId),
          );
          const targets = await resolveKillTargets(scope, tenantId, reader);
          return { targets, tenantIds: sortedUnique(runs.map((run) => run.tenantId)) };
        });
      } finally {
        child.end();
      }
    });
  }

  private async fireAuthorised(
    input: OperatorKillFireInput,
    span: Span,
    setScope: (scope: string) => void,
  ): Promise<KillTriggerResponse> {
    const { principal } = input;
    const key = requireIdempotencyKey(input.idempotencyKey);
    const parsed = operatorKillRequestSchema.safeParse(input.body);
    if (!parsed.success) throw invalid('kill request', parsed.error);
    const { scope, reason } = parsed.data;
    const tenantId = parsed.data.tenantId ?? null;
    setScope(scope);
    span.setAttributes({ 'bw.kill.scope': scope, 'bw.operator_id': principal.id });
    await this.tenantSlug(tenantId);

    const fingerprint = fingerprintOf(scope, tenantId, reason);
    const previous = await this.deps.store.findByIdempotencyKey(key);
    if (previous !== null) return this.replay(previous, fingerprint);

    const { targets, tenantIds } = await this.inspect(principal.id, scope, tenantId);
    const now = this.clock.now().toISOString();
    const nothingToStop = targets.runIds.length === 0;
    const candidate = killEventSchema.parse({
      id: this.nextId(),
      tenantId,
      scope,
      scopeRefId: null,
      source: SOURCE,
      actorType: 'operator',
      actorRef: principal.id,
      reason,
      // Nothing in scope is running: the kill is already complete, in zero time.
      status: nothingToStop ? 'halted' : 'initiated',
      triggeredAt: now,
      egressBlockedAt: null,
      sandboxesTerminatedAt: null,
      keysRevokedAt: null,
      workflowsCancelledAt: null,
      completedAt: nothingToStop ? now : null,
      haltMs: nothingToStop ? 0 : null,
      affected: { runs: 0, sessions: 0, sandboxes: 0, keys: 0, workflows: 0 },
      reenabledAt: null,
      reenabledBy: null,
      createdAt: now,
      updatedAt: now,
    });

    const inserted = await this.deps.store.insertOrGet({
      event: candidate,
      idempotency: { key, fingerprint },
    });
    if (inserted.kind === 'idempotent_replay') return this.replay(inserted, fingerprint);
    if (inserted.kind === 'in_flight') {
      throw new OperatorKillError(
        'KILL_ALREADY_IN_PROGRESS',
        `kill ${inserted.event.id} is already in progress for this scope`,
      );
    }
    const event = inserted.event;
    span.setAttribute('bw.kill.event_id', event.id);

    let enqueueError: unknown = null;
    if (event.status === 'initiated') {
      try {
        await this.deps.signaler.signal({
          killEventId: event.id,
          tenantId,
          scope,
          targets,
          triggeredAt: event.triggeredAt,
        });
      } catch (err) {
        enqueueError = err;
        this.deps.logger.error(
          { killEventId: event.id, scope, err },
          'operator kill propagation enqueue failed',
        );
      }
    }

    await this.auditFired(event, scope, tenantId, tenantIds, input.traceId);
    this.deps.logger.info(
      { operatorId: principal.id, scope, tenantId, haltMs: event.haltMs, killEventId: event.id },
      'operator kill fired',
    );

    // The kill path could not be reached: say so. Never hand back a 202 for a kill nobody is running.
    if (enqueueError !== null) {
      throw new AppError('TEMPORAL_UNAVAILABLE', 'kill propagation could not be enqueued', {
        detail: `kill ${event.id} is recorded but the kill path could not be reached`,
        cause: enqueueError,
      });
    }
    return { killEventId: event.id, status: event.status, triggeredAt: event.triggeredAt };
  }

  private replay(
    previous: { readonly event: KillEvent; readonly fingerprint: string },
    fingerprint: string,
  ): KillTriggerResponse {
    if (previous.fingerprint !== fingerprint) {
      throw new KillApiError(
        'IDEMPOTENCY_KEY_MISMATCH',
        'this Idempotency-Key was already used with a different kill request',
      );
    }
    const { event } = previous;
    if (isPartial(event)) throw partialError(event);
    return { killEventId: event.id, status: event.status, triggeredAt: event.triggeredAt };
  }

  /** Operator stream plus the stream of every affected tenant (§8.8). */
  private async auditFired(
    event: KillEvent,
    scope: OperatorKillScope,
    tenantId: string | null,
    affectedTenantIds: readonly string[],
    traceId: string | null,
  ): Promise<void> {
    const base = {
      action: 'operator.kill_fired',
      severity: 'critical',
      outcome: 'success',
      actor: { type: 'operator', id: event.actorRef },
      target: targetOf(scope, tenantId),
      reason: event.reason,
      occurredAt: event.triggeredAt,
      traceId,
      metadata: {
        killEventId: event.id,
        scope,
        tenantId,
        haltMs: event.haltMs,
        status: event.status,
        tenantsAffected: affectedTenantIds.length,
      },
    } as const;
    const streams = scope === 'tenant' && tenantId !== null ? [tenantId] : affectedTenantIds;
    for (const stream of [null, ...streams]) {
      await this.writeAudit({ ...base, tenantId: stream });
    }
  }

  /** Records the measured halt time once, when its final status is first read. */
  private observeHalt(event: KillEvent): void {
    if (isKillOpen(event.status) || event.haltMs === null || this.observed.has(event.id)) return;
    if (this.observed.size >= OBSERVED_CAP) {
      const oldest = this.observed.values().next();
      if (!oldest.done) this.observed.delete(oldest.value);
    }
    this.observed.add(event.id);
    this.deps.metrics.haltMs.observe(event.haltMs);
    const breaches = killSlaBreaches({
      firedAt: event.triggeredAt,
      egressBlockedAt: event.egressBlockedAt,
      sandboxesTerminatedAt: event.sandboxesTerminatedAt,
    });
    if (breaches.gateway) this.deps.metrics.slaBreach.inc({ target: 'gateway' });
    if (breaches.sandboxes) this.deps.metrics.slaBreach.inc({ target: 'sandboxes' });
  }

  /** A failed append never undoes or blocks a kill (stopping is the safe direction); it pages. */
  private async writeAudit(record: OperatorKillAuditRecord): Promise<void> {
    try {
      await this.deps.audit.append(record);
    } catch (err) {
      this.deps.metrics.auditFailures.inc({ action: record.action });
      this.deps.logger.error({ action: record.action, err }, 'operator kill audit append failed');
    }
  }
}

function targetOf(scope: OperatorKillScope, tenantId: string | null): AuditTarget {
  return scope === 'tenant' && tenantId !== null
    ? { type: 'tenant', id: tenantId }
    : { type: 'platform', id: 'global' };
}

function requireIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw new KillApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'POST /operator/v1/kill requires an Idempotency-Key header',
    );
  }
  if (!idempotencyKeySchema.safeParse(raw).success) {
    throw new KillApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must be 8 to 255 visible ASCII characters',
    );
  }
  return raw;
}

function resultOf(err: unknown): OperatorKillResult {
  if (err instanceof OperatorKillError) {
    return err.code === 'NOT_OPERATOR'
      ? 'forbidden'
      : err.code === 'KILL_PARTIAL'
        ? 'partial'
        : 'in_progress';
  }
  return err instanceof ValidationError || err instanceof KillApiError ? 'invalid' : 'error';
}
