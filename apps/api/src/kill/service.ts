import { createHash } from 'node:crypto';

import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  type AuditActor,
  type AuditTarget,
  idempotencyKeySchema,
  KILL_API_SCOPES,
  type KillApiScope,
  type KillEvent,
  killEventSchema,
  type KillTargetSet,
  killTriggerRequestSchema,
  type KillTriggerResponse,
} from '@blackwing/contracts';
import { hasPermission, KILL_RESOLVE_SPAN, resolveKillTargets } from '@blackwing/domain';
import { AuthError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type Clock, systemClock } from '@blackwing/time';

import { KillApiError } from './errors.js';

import type { KillMetrics } from './metrics.js';
import type { KillPolicyEngine, KillPolicyResource } from './policy.js';
import type {
  KillAuditRecord,
  KillAuditSink,
  KillEventStore,
  KillPrincipal,
  KillPropagationSignaler,
  KillResourceReader,
  KillTargetReaderFactory,
} from './ports.js';
import type { Logger } from '@blackwing/logger';

export const KILL_TRIGGER_SPAN = 'kill.trigger';
const TRACER_NAME = '@blackwing/api/kill';
export const SOC_KILL_TRIGGER_SPAN = 'soc_kill.trigger';
const SOURCE = 'api';
const SOC_KILL_REASON = 'Stopped by the customer SOC through a kill link';

export interface KillServiceDeps {
  readonly store: KillEventStore;
  readonly resources: KillResourceReader;
  readonly targets: KillTargetReaderFactory;
  readonly signaler: KillPropagationSignaler;
  readonly audit: KillAuditSink;
  readonly policy: KillPolicyEngine;
  readonly logger: Logger;
  readonly metrics: KillMetrics;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly tracer?: Tracer;
}

export interface KillTriggerInput {
  readonly principal: KillPrincipal;
  readonly body: unknown;
  /** Raw `Idempotency-Key` header, if any. */
  readonly idempotencyKey: string | undefined;
  readonly traceId: string | null;
}

export interface KillTriggerResult {
  readonly response: KillTriggerResponse;
  /** True when this request created the event (false: idempotent replay or joined an open kill). */
  readonly created: boolean;
}

/** A SOC-link kill (KILL-007): the verified token's scope, and the key that dedupes this use. */
export interface SocKillTriggerInput {
  readonly tenantId: string;
  readonly scope: 'run' | 'asset';
  readonly scopeRefId: string;
  /** `soc_kill_tokens.id` (the token's `jti`): the event's actorRef. Never the raw token. */
  readonly tokenId: string;
  /** Unique per token use, so a retried request cannot create a second event. */
  readonly idempotencyKey: string;
  readonly traceId: string | null;
}

/** What differs between a console/API kill and a SOC-link kill once the caller is authorised. */
interface KillExecution {
  readonly tenantId: string;
  readonly request: ParsedKill;
  readonly key: string;
  readonly source: 'api' | 'soc_link';
  readonly actorType: string;
  readonly actorRef: string;
  readonly auditAction: 'kill.triggered' | 'soc_kill.triggered';
  readonly auditActor: AuditActor;
  readonly auditMetadata: Readonly<Record<string, string>>;
  readonly traceId: string | null;
}

interface ParsedKill {
  readonly scope: KillApiScope;
  readonly scopeRefId: string | null;
  readonly reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Body validation with the stable kill codes (requirement 6). Order matters: `global` gets its own
 * code before anything else, then an unknown scope, then a missing ref, then the generic schema.
 */
export function parseKillRequest(body: unknown): ParsedKill {
  if (!isRecord(body)) throw new ValidationError('request body must be a JSON object');
  const { scope, scopeRefId } = body;
  if (scope === 'global') {
    throw new KillApiError(
      'KILL_GLOBAL_NOT_ALLOWED_HERE',
      'a global kill is a platform-operator action and is not accepted on this endpoint',
    );
  }
  if (typeof scope !== 'string' || !(KILL_API_SCOPES as readonly string[]).includes(scope)) {
    throw new KillApiError(
      'KILL_SCOPE_INVALID',
      `scope must be one of ${KILL_API_SCOPES.join(', ')}`,
    );
  }
  if ((scope === 'run' || scope === 'asset') && (scopeRefId === undefined || scopeRefId === null)) {
    throw new KillApiError(
      'KILL_REF_REQUIRED',
      `a ${scope} kill must name the ${scope} in scopeRefId`,
    );
  }
  if (scope === 'tenant' && scopeRefId !== undefined) {
    throw new KillApiError('KILL_SCOPE_INVALID', 'a tenant kill must not carry a scopeRefId');
  }
  const parsed = killTriggerRequestSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(body)');
    throw new ValidationError('invalid kill request', {
      detail: `invalid fields: ${[...new Set(fields)].join(', ')}`,
    });
  }
  return {
    scope: parsed.data.scope,
    scopeRefId: parsed.data.scopeRefId ?? null,
    reason: parsed.data.reason,
  };
}

/** Stable fingerprint of a kill request, to detect an `Idempotency-Key` reused with another body. */
export function killRequestFingerprint(request: ParsedKill): string {
  return createHash('sha256')
    .update(JSON.stringify([request.scope, request.scopeRefId, request.reason]), 'utf8')
    .digest('hex');
}

function targetCounts(targets: KillTargetSet): Record<string, number> {
  return {
    runs: targets.runIds.length,
    sessions: targets.sessionIds.length,
    sandboxes: targets.sandboxIds.length,
    keys: targets.virtualKeyIds.length,
    egressIdentities: targets.egressIdentities.length,
    workflows: targets.workflowIds.length,
  };
}

function actorOf(principal: KillPrincipal): AuditActor {
  const tokenId = principal.tokenId === undefined ? {} : { tokenId: principal.tokenId };
  return principal.type === 'user'
    ? { type: 'user', id: principal.id, ...tokenId }
    : { type: 'service', id: principal.id, ...tokenId };
}

function targetOf(request: ParsedKill, tenantId: string): AuditTarget {
  if (request.scope === 'tenant') return { type: 'tenant', id: tenantId };
  return { type: request.scope, id: request.scopeRefId ?? tenantId };
}

/**
 * The kill trigger (KILL-003): validate, authorise (RBAC then Cedar), resolve, persist, signal, audit,
 * respond. It never awaits propagation (KILL-004 owns that) and it never lets a missing tenant through.
 */
export class KillService {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly tracer: Tracer;

  constructor(private readonly deps: KillServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.nextId = deps.idGenerator ?? newId;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async trigger(input: KillTriggerInput): Promise<KillTriggerResult> {
    const started = this.clock.monotonicMs();
    return this.tracer.startActiveSpan(KILL_TRIGGER_SPAN, async (span) => {
      try {
        const result = await this.triggerInSpan(input, span);
        this.deps.metrics.triggerLatency.observe(
          { scope: result.scope },
          this.clock.monotonicMs() - started,
        );
        return result.result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async get(principal: KillPrincipal, killEventId: string): Promise<KillEvent> {
    const tenantId = this.requireTenant(principal);
    if (!hasPermission(principal.roles, 'run:read')) {
      throw new KillApiError('KILL_FORBIDDEN', 'reading kill events requires run:read');
    }
    const event = await this.deps.store.get(tenantId, killEventId);
    // Another tenant's event and a missing one are the same answer (no existence oracle, §8.6).
    if (event?.tenantId !== tenantId) {
      throw new NotFoundError('kill event not found');
    }
    return event;
  }

  /** The tenant's kill history, newest first. Reading kill events needs `run:read`, as `get` does. */
  async list(principal: KillPrincipal, limit: number): Promise<readonly KillEvent[]> {
    const tenantId = this.requireTenant(principal);
    if (!hasPermission(principal.roles, 'run:read')) {
      throw new KillApiError('KILL_FORBIDDEN', 'reading kill events requires run:read');
    }
    return this.deps.store.recent(tenantId, limit);
  }

  private requireTenant(principal: KillPrincipal): string {
    if (principal.tenantId === null || principal.tenantId.length === 0) {
      throw new AuthError('no tenant context on the authenticated principal', {
        detail: 'a tenant context is required',
      });
    }
    return principal.tenantId;
  }

  private async triggerInSpan(
    input: KillTriggerInput,
    span: Span,
  ): Promise<{ readonly scope: KillApiScope; readonly result: KillTriggerResult }> {
    const { principal } = input;
    const tenantId = this.requireTenant(principal);
    const key = this.requireIdempotencyKey(input.idempotencyKey);
    const request = parseKillRequest(input.body);
    span.setAttributes({ 'bw.kill.scope': request.scope, 'bw.tenant_id': tenantId });

    await this.authorise(principal, tenantId, request, input.traceId);

    const result = await this.execute(
      {
        tenantId,
        request,
        key,
        source: SOURCE,
        actorType: principal.type,
        actorRef: principal.id,
        auditAction: 'kill.triggered',
        auditActor: actorOf(principal),
        auditMetadata: {},
        traceId: input.traceId,
      },
      span,
    );
    return { scope: request.scope, result };
  }

  /**
   * The login-free SOC kill (KILL-007). The caller has already verified the signed link, so there is
   * no RBAC/Cedar step: possession of a live link IS the authority, and a kill is always permitted
   * (never blocked by asset verification or scope). Everything after authorisation is the same path
   * as {@link trigger}: resolve, persist (one open kill per scope), signal, audit.
   */
  async triggerFromSocLink(input: SocKillTriggerInput): Promise<KillTriggerResult> {
    return this.tracer.startActiveSpan(SOC_KILL_TRIGGER_SPAN, async (span) => {
      try {
        span.setAttributes({ 'bw.kill.scope': input.scope, 'bw.tenant_id': input.tenantId });
        return await this.execute(
          {
            tenantId: input.tenantId,
            request: { scope: input.scope, scopeRefId: input.scopeRefId, reason: SOC_KILL_REASON },
            key: input.idempotencyKey,
            source: 'soc_link',
            actorType: 'soc_link',
            actorRef: input.tokenId,
            auditAction: 'soc_kill.triggered',
            auditActor: { type: 'anonymous' },
            auditMetadata: { tokenId: input.tokenId },
            traceId: input.traceId,
          },
          span,
        );
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  private async execute(exec: KillExecution, span: Span): Promise<KillTriggerResult> {
    const { tenantId, request, key } = exec;
    const fingerprint = killRequestFingerprint(request);
    const previous = await this.deps.store.findByIdempotencyKey(tenantId, key);
    if (previous !== null) {
      return this.replay(previous, fingerprint);
    }

    const targets = await this.tracer.startActiveSpan(KILL_RESOLVE_SPAN, async (child) => {
      try {
        return await this.deps.targets.withTenantReader(tenantId, (reader) =>
          resolveKillTargets(request.scope, request.scopeRefId, reader),
        );
      } finally {
        child.end();
      }
    });

    const now = this.clock.now().toISOString();
    const nothingToStop = targets.runIds.length === 0;
    const candidate: KillEvent = killEventSchema.parse({
      id: this.nextId(),
      tenantId,
      scope: request.scope,
      scopeRefId: request.scopeRefId,
      source: exec.source,
      actorType: exec.actorType,
      actorRef: exec.actorRef,
      reason: request.reason,
      // Nothing in scope is running: the kill is already complete, in zero time (edge case 1).
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
    if (inserted.kind === 'idempotent_replay') {
      return this.replay(inserted, fingerprint);
    }
    const event = inserted.event;
    const created = inserted.kind === 'created';
    span.setAttribute('bw.kill.event_id', event.id);

    if (created && event.status === 'initiated') {
      await this.enqueue(event, request, tenantId, targets);
    }
    if (created) {
      this.deps.metrics.events.inc({
        scope: event.scope,
        source: exec.source,
        status: event.status,
      });
    }

    await this.writeAudit({
      action: exec.auditAction,
      severity: 'critical',
      outcome: 'success',
      tenantId,
      actor: exec.auditActor,
      target: targetOf(request, tenantId),
      occurredAt: now,
      traceId: exec.traceId,
      metadata: {
        ...exec.auditMetadata,
        killEventId: event.id,
        scope: request.scope,
        scopeRefId: request.scopeRefId,
        source: exec.source,
        status: event.status,
        joinedOpenKill: !created,
        reasonLength: request.reason.length,
        ...Object.fromEntries(
          Object.entries(targetCounts(targets)).map(([k, v]) => [`targets.${k}`, v]),
        ),
      },
    });

    this.deps.logger.info(
      {
        killEventId: event.id,
        scope: request.scope,
        scopeRefId: request.scopeRefId,
        actorRef: exec.actorRef,
        source: exec.source,
        targetCounts: targetCounts(targets),
        reasonLength: request.reason.length,
        status: event.status,
        joinedOpenKill: !created,
      },
      created ? 'kill triggered' : 'kill joined an open kill event for the same scope',
    );

    return {
      response: { killEventId: event.id, status: event.status, triggeredAt: event.triggeredAt },
      created,
    };
  }

  private requireIdempotencyKey(raw: string | undefined): string {
    if (raw === undefined || raw.length === 0) {
      throw new KillApiError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'POST /v1/kill requires an Idempotency-Key header',
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

  private replay(
    previous: { readonly event: KillEvent; readonly fingerprint: string },
    fingerprint: string,
  ): KillTriggerResult {
    if (previous.fingerprint !== fingerprint) {
      throw new KillApiError(
        'IDEMPOTENCY_KEY_MISMATCH',
        'this Idempotency-Key was already used with a different kill request',
      );
    }
    const { event } = previous;
    return {
      response: { killEventId: event.id, status: event.status, triggeredAt: event.triggeredAt },
      created: false,
    };
  }

  /** RBAC permission, then the Cedar resource check. Every refusal is audited as `kill.forbidden`. */
  private async authorise(
    principal: KillPrincipal,
    tenantId: string,
    request: ParsedKill,
    traceId: string | null,
  ): Promise<void> {
    const refuse = async (why: string, policyErrors: readonly string[]): Promise<never> => {
      await this.writeAudit({
        action: 'kill.forbidden',
        severity: 'warning',
        outcome: 'denied',
        tenantId,
        actor: actorOf(principal),
        target: targetOf(request, tenantId),
        occurredAt: this.clock.now().toISOString(),
        traceId,
        metadata: {
          scope: request.scope,
          scopeRefId: request.scopeRefId,
          source: SOURCE,
          check: why,
          policyErrors: policyErrors.length,
        },
      });
      this.deps.logger.warn(
        {
          scope: request.scope,
          scopeRefId: request.scopeRefId,
          actorRef: principal.id,
          check: why,
        },
        'kill refused',
      );
      throw new KillApiError('KILL_FORBIDDEN', 'you are not permitted to kill this scope');
    };

    if (!hasPermission(principal.roles, 'kill:trigger')) await refuse('rbac', []);

    const resource = await this.policyResource(tenantId, request);
    const decision = this.deps.policy.authorize(
      { userId: principal.id, tenantId, roles: principal.roles },
      resource,
    );
    if (decision.decision !== 'allow') await refuse('cedar', decision.errors);
  }

  private async policyResource(tenantId: string, request: ParsedKill): Promise<KillPolicyResource> {
    if (request.scope === 'tenant') return { scope: 'tenant', id: tenantId, tenantId };
    const refId = request.scopeRefId ?? '';
    if (request.scope === 'run') {
      const run = await this.deps.resources.getRun(tenantId, refId);
      if (run === null) throw new NotFoundError('run not found');
      return { scope: 'run', id: run.id, tenantId: run.tenantId };
    }
    const asset = await this.deps.resources.getAsset(tenantId, refId);
    if (asset === null) throw new NotFoundError('asset not found');
    return {
      scope: 'asset',
      id: asset.id,
      tenantId: asset.tenantId,
      ownerUserIds: asset.ownerUserIds,
    };
  }

  /** Enqueue failure leaves the event `initiated` for the KILL-004 reconciler and pages (edge case 3). */
  private async enqueue(
    event: KillEvent,
    request: ParsedKill,
    tenantId: string,
    targets: KillTargetSet,
  ): Promise<void> {
    try {
      await this.deps.signaler.signal({
        killEventId: event.id,
        tenantId,
        scope: request.scope,
        scopeRefId: request.scopeRefId,
        targets,
        triggeredAt: event.triggeredAt,
      });
    } catch (err) {
      this.deps.metrics.enqueueFailures.inc({ scope: request.scope });
      this.deps.logger.error(
        { killEventId: event.id, scope: request.scope, err },
        'kill propagation enqueue failed; event stays initiated for the reconciler',
      );
    }
  }

  /**
   * Appends to the ledger. A failed append never undoes or blocks a kill (stopping is always the safe
   * direction), but it is logged at error level and counted so it pages.
   */
  private async writeAudit(record: KillAuditRecord): Promise<void> {
    try {
      await this.deps.audit.append(record);
    } catch (err) {
      this.deps.metrics.auditFailures.inc({ action: record.action });
      this.deps.logger.error({ action: record.action, err }, 'kill audit append failed');
    }
  }
}
