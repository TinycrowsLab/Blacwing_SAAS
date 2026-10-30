import { type AuditEmitter, createAuditEmitter } from '@blackwing/audit';
import { type Database, QuotaUsageRepository, type TenantTx, withTenant } from '@blackwing/db';
import { hashTenantId } from '@blackwing/db/tenant-context';
import {
  type PlanLimits,
  type PlanName,
  type QuotaDecision,
  type QuotaResource,
  evaluateCostCap,
  evaluateCountQuota,
  hasPermission,
  planLimits,
  utcMonthBounds,
  isPlanName,
} from '@blackwing/domain';
import { AppError, ForbiddenRoleError } from '@blackwing/errors';

import { CostCapExceededError, QuotaExceededError } from './errors.js';
import { auditSqlTx } from '../assets/audit-tx.js';

import type { QuotaMetrics } from './metrics.js';
import type { Logger } from '@blackwing/logger';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface QuotaPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

/** One refused creation: the resource and the decision that refused it. */
export interface QuotaDenial {
  readonly resource: QuotaResource;
  readonly decision: QuotaDecision;
}

/** What a creation point needs from the quota service: decide inside its own transaction. */
export interface QuotaEnforcer {
  enforceInTx(
    tx: TenantTx,
    principal: QuotaPrincipal,
    resource: QuotaResource,
    requested?: number,
  ): Promise<QuotaDenial | undefined>;
}

/** The problem a denied creation answers with (`409 QUOTA_EXCEEDED` or `402 COST_CAP_EXCEEDED`). */
export function quotaErrorOf(denial: QuotaDenial): AppError {
  const { decision, resource } = denial;
  if (resource === 'monthly_cost')
    return new CostCapExceededError(decision.limit ?? 0, decision.used);
  return new QuotaExceededError(resource, decision.limit ?? 0, decision.used);
}

/** The read model of `GET /v1/tenant/quotas`: used against limit per resource, `null` limit = unlimited. */
interface QuotaCountView {
  readonly used: number;
  readonly limit: number | null;
}

export interface QuotaView {
  readonly plan: PlanName;
  readonly assets: QuotaCountView;
  readonly concurrentRuns: QuotaCountView;
  readonly members: QuotaCountView;
  readonly monthlyCostUsd: {
    readonly used: number;
    readonly limit: number | null;
    /** Start of the current UTC month (inclusive) and the next one (exclusive), for the console. */
    readonly periodStart: string;
    readonly periodEnd: string;
  };
}

export interface QuotaServiceDeps {
  readonly database: Database;
  readonly usage?: QuotaUsageRepository;
  readonly audit?: AuditEmitter;
  readonly metrics: QuotaMetrics;
  readonly logger: Pick<Logger, 'info'>;
  /** Clock for the cost-cap month. Tests pass a fixed instant. */
  readonly now?: () => Date;
}

const SETTINGS_READ = 'settings:read';

/**
 * Plan quotas (TENANT-009, §8.6, §8.11). Creation points call `enforceInTx` inside their own tenant transaction:
 * the lock, the count and the write commit together, so two creates at the boundary cannot both succeed. A
 * refusal writes `tenant.quota_exceeded` in that transaction and returns the denial; the caller commits, then
 * raises {@link quotaErrorOf}, so the audit row survives the refusal. Any failure while measuring throws and
 * the creation does not happen (fail closed).
 */
export class QuotaService implements QuotaEnforcer {
  private readonly usage: QuotaUsageRepository;
  private readonly audit: AuditEmitter;
  private readonly now: () => Date;

  constructor(private readonly deps: QuotaServiceDeps) {
    this.usage = deps.usage ?? new QuotaUsageRepository();
    this.audit = deps.audit ?? createAuditEmitter();
    this.now = deps.now ?? (() => new Date());
  }

  async enforceInTx(
    tx: TenantTx,
    principal: QuotaPrincipal,
    resource: QuotaResource,
    requested = 1,
  ): Promise<QuotaDenial | undefined> {
    const { tenantId } = principal;
    if (resource !== 'monthly_cost') await this.usage.lockResource(tx, tenantId, resource);
    const { plan, limits } = await this.planOf(tx, tenantId);
    const decision = await this.measure(tx, tenantId, resource, requested, limits);
    if (decision.allowed) return undefined;

    this.deps.metrics.exceeded(resource);
    await this.audit.emitAuditInTx(auditSqlTx(tx), {
      tenantId,
      action: 'tenant.quota_exceeded',
      actor: { type: 'user', id: principal.userId },
      target: { type: 'tenant', id: tenantId },
      outcome: 'failure',
      metadata: {
        resource,
        plan,
        limit: decision.limit ?? 0,
        used: decision.used,
      },
    });
    this.deps.logger.info(
      { tenantHash: hashTenantId(tenantId), resource, limit: decision.limit, used: decision.used },
      'tenant.quota_exceeded',
    );
    return { resource, decision };
  }

  /** The quota read model for the console (`GET /v1/tenant/quotas`). Needs the `settings:read` permission. */
  async view(principal: QuotaPrincipal): Promise<QuotaView> {
    const { tenantId, userId } = principal;
    return withTenant(this.deps.database, tenantId, async (tx) => {
      const roles = await this.usage.rolesOf(tx, tenantId, userId);
      if (!hasPermission(roles, SETTINGS_READ)) {
        throw new ForbiddenRoleError('Your role does not grant access to the quotas.');
      }
      const { plan, limits } = await this.planOf(tx, tenantId);
      const now = this.now();
      const { start, end } = utcMonthBounds(now);
      // One transaction is one connection: the reads run in sequence.
      const assets = await this.usage.countAssets(tx, tenantId);
      const concurrentRuns = await this.usage.countConcurrentRuns(tx, tenantId);
      const members = await this.usage.countMembers(tx, tenantId);
      const monthlyCostUsd = await this.usage.monthlyCostUsd(tx, tenantId, start, end);
      return {
        plan,
        assets: { used: assets, limit: limits.maxAssets },
        concurrentRuns: { used: concurrentRuns, limit: limits.maxConcurrentRuns },
        members: { used: members, limit: limits.maxMembers },
        monthlyCostUsd: {
          used: monthlyCostUsd,
          limit: limits.monthlyCostCapUsd,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
        },
      };
    });
  }

  /** The tenant's plan. Fails closed: a tenant this transaction cannot see, or an unknown plan, is an error. */
  private async planOf(
    tx: TenantTx,
    tenantId: string,
  ): Promise<{ plan: PlanName; limits: PlanLimits }> {
    const plan = await this.usage.planOf(tx, tenantId);
    if (plan === undefined || !isPlanName(plan)) {
      throw new AppError('INTERNAL', 'tenant plan is unavailable; refusing the quota check');
    }
    return { plan, limits: planLimits(plan) };
  }

  private async measure(
    tx: TenantTx,
    tenantId: string,
    resource: QuotaResource,
    requested: number,
    limits: PlanLimits,
  ): Promise<QuotaDecision> {
    switch (resource) {
      case 'assets':
        return evaluateCountQuota(
          limits.maxAssets,
          await this.usage.countAssets(tx, tenantId),
          requested,
        );
      case 'concurrent_runs':
        return evaluateCountQuota(
          limits.maxConcurrentRuns,
          await this.usage.countConcurrentRuns(tx, tenantId),
          requested,
        );
      case 'members':
        return evaluateCountQuota(
          limits.maxMembers,
          await this.usage.countMembers(tx, tenantId),
          requested,
        );
      case 'monthly_cost': {
        const { start, end } = utcMonthBounds(this.now());
        return evaluateCostCap(
          limits.monthlyCostCapUsd,
          await this.usage.monthlyCostUsd(tx, tenantId, start, end),
        );
      }
    }
  }
}
