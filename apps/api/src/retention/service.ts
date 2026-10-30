import { trace, type Tracer } from '@opentelemetry/api';

import {
  type AuditActor,
  type AuditTarget,
  RETENTION_DATA_CLASSES,
  RETENTION_DEFAULTS,
  type RetentionDataClass,
  type RetentionPolicySet,
  retentionPolicyUpdateSchema,
  type RetentionPolicyUpdate,
} from '@blackwing/contracts';
import { hasPermission, resolveRetention, type RetentionPolicyRow } from '@blackwing/domain';
import { ForbiddenError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { computeEtag, requireIfMatch } from '../concurrency/index.js';

import type { RetentionMetrics } from './metrics.js';
import type {
  RetentionAuditRecord,
  RetentionPolicyWrite,
  RetentionPrincipal,
  RetentionStore,
  RetentionTx,
  StoredRetentionPolicy,
} from './ports.js';
import type { Logger } from '@blackwing/logger';

/** Span around one policy write (observability for RETAIN-001). */
const RETENTION_UPDATE_SPAN = 'retention.policy.update';

const TRACER_NAME = '@blackwing/api';

export interface RetentionServiceDeps {
  readonly store: RetentionStore;
  readonly metrics: RetentionMetrics;
  readonly tracer?: Tracer;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/** A policy view and its strong ETag, ready for the HTTP layer. */
export interface RetentionResult {
  readonly body: RetentionPolicySet;
  readonly etag: string;
}

/**
 * Tenant retention policies (RETAIN-001, F-retention): read the effective policy set, and replace it
 * under optimistic concurrency. Every class is always reported: a class without a stored row shows the
 * platform default, so a sweep or a reader never sees "keep forever" by omission.
 */
export class RetentionService {
  private readonly store: RetentionStore;
  private readonly metrics: RetentionMetrics;
  private readonly tracer: Tracer;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  constructor(deps: RetentionServiceDeps) {
    this.logger = deps.logger;
    this.store = deps.store;
    this.metrics = deps.metrics;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.now = deps.now ?? (() => new Date());
  }

  async get(principal: RetentionPrincipal): Promise<RetentionResult> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, 'settings:read');
    const view = viewOf(await this.store.read(tenantId), tenantId);
    return { body: view, etag: computeEtag(view) };
  }

  /**
   * Replaces the listed classes. `ifMatch` is the `If-Match` header: required, checked against the
   * current view inside the transaction, so a concurrent writer makes this request 412 (re-read and
   * retry). Changed classes are audited in the same transaction and counted; unchanged ones are not.
   */
  async replace(
    principal: RetentionPrincipal,
    body: unknown,
    ifMatch: string | readonly string[] | undefined,
  ): Promise<RetentionResult> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, 'settings:write');
    const parsed = retentionPolicyUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? '' : ` at ${issue.path.join('.')}`;
      throw new ValidationError(`invalid retention policy update${where}`, {
        detail: issue?.message ?? 'invalid retention policy update',
      });
    }
    const update = parsed.data;
    return this.tracer.startActiveSpan(RETENTION_UPDATE_SPAN, async (span) => {
      try {
        const result = await this.store.transact(tenantId, (tx) =>
          this.applyUpdate(principal, tenantId, update, ifMatch, tx),
        );
        span.setAttribute('retention.changed', result.changed);
        this.logger?.info(
          { tenantId, changedClasses: result.changed, op: 'retention.policy.update' },
          'retention policies updated',
        );
        return { body: result.view, etag: result.etag };
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async applyUpdate(
    principal: RetentionPrincipal,
    tenantId: string,
    update: RetentionPolicyUpdate,
    ifMatch: string | readonly string[] | undefined,
    tx: RetentionTx,
  ): Promise<{ view: RetentionPolicySet; etag: string; changed: number }> {
    const stored = await tx.lockAndLoad();
    const current = viewOf(stored, tenantId);
    const { etag } = requireIfMatch(computeEtag(current), ifMatch);

    const writes: RetentionPolicyWrite[] = [];
    const audits: RetentionAuditRecord[] = [];
    for (const item of update.policies) {
      const before = current.policies.find((p) => p.dataClass === item.dataClass);
      if (before === undefined) continue;
      if (before.retentionDays === item.retentionDays && before.enabled === item.enabled) continue;
      writes.push({
        tenantId,
        dataClass: item.dataClass,
        retentionDays: item.retentionDays,
        minRetentionDays: RETENTION_DEFAULTS[item.dataClass].minRetentionDays,
        enabled: item.enabled,
      });
      audits.push(
        auditOf(principal, tenantId, item.dataClass, before, item, this.now().toISOString()),
      );
    }
    if (writes.length === 0) return { view: current, etag, changed: 0 };

    await tx.upsert(writes);
    for (const record of audits) await tx.appendAudit(record);
    for (const write of writes) this.metrics.updates.inc({ data_class: write.dataClass });

    const next = viewOf(await tx.lockAndLoad(), tenantId);
    return { view: next, etag: computeEtag(next), changed: writes.length };
  }
}

/** The effective policy of every class, in the stable order of `RETENTION_DATA_CLASSES`. */
function viewOf(stored: readonly StoredRetentionPolicy[], tenantId: string): RetentionPolicySet {
  const rows: readonly RetentionPolicyRow[] = stored;
  return {
    policies: RETENTION_DATA_CLASSES.map((dataClass) => {
      const effective = resolveRetention(rows, tenantId, dataClass);
      const row = stored.find((s) => s.tenantId === tenantId && s.dataClass === dataClass);
      return {
        dataClass,
        retentionDays: effective.retentionDays,
        minRetentionDays: effective.minRetentionDays,
        enabled: row?.enabled ?? true,
        legalHoldOverrides: false,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  };
}

function requireTenant(principal: RetentionPrincipal): string {
  if (principal.tenantId === null || principal.tenantId.trim() === '') {
    throw new TenantContextMissingError('retention policies require a tenant context', {
      reason: 'missing',
    });
  }
  return principal.tenantId;
}

function requirePermission(
  principal: RetentionPrincipal,
  permission: 'settings:read' | 'settings:write',
): void {
  if (!hasPermission(principal.roles, permission)) {
    throw new ForbiddenError('retention policies: permission denied', {
      detail: `the caller lacks ${permission}`,
    });
  }
}

function actorOf(principal: RetentionPrincipal): AuditActor {
  const tokenId = principal.tokenId === undefined ? {} : { tokenId: principal.tokenId };
  return { type: principal.type, id: principal.id, ...tokenId };
}

function auditOf(
  principal: RetentionPrincipal,
  tenantId: string,
  dataClass: RetentionDataClass,
  before: { readonly retentionDays: number; readonly enabled: boolean },
  after: { readonly retentionDays: number; readonly enabled: boolean },
  occurredAt: string,
): RetentionAuditRecord {
  const target: AuditTarget = { type: 'config', id: 'retention_policies' };
  return {
    action: 'config.changed',
    tenantId,
    actor: actorOf(principal),
    target,
    outcome: 'success',
    occurredAt,
    traceId: null,
    metadata: {
      area: 'retention',
      dataClass,
      fromRetentionDays: before.retentionDays,
      toRetentionDays: after.retentionDays,
      fromEnabled: before.enabled,
      toEnabled: after.enabled,
    },
  };
}
