// Tenant usage counts for the plan quota checks (TENANT-009, CONTEXT_PACK §7, §8.6). Every read runs on the
// caller's tenant transaction (`withTenant`), so RLS and the explicit tenant predicate both apply: another
// tenant's assets, runs, members or spend never enter a count. Methods take the transaction, so the check and
// the write it guards commit together.

import { and, eq, gte, isNull, lt, notInArray, sql } from 'drizzle-orm';

import { assets } from './schema/assets.js';
import { costLedger } from './schema/cost.js';
import { runs } from './schema/runs.js';
import { memberships, tenants } from './schema/tenancy.js';

import type { TenantTx } from './with-tenant.js';

/** States a run leaves for good (§3.3). Only the others hold a concurrency slot. */
const TERMINAL_RUN_STATES = ['completed', 'cancelled', 'killed', 'failed', 'expired'] as const;

export interface QuotaUsageCounts {
  readonly assets: number;
  readonly concurrentRuns: number;
  readonly members: number;
  /** Month-to-date spend in USD over `[monthStart, monthEnd)`. */
  readonly monthlyCostUsd: number;
}

/** The count resources. The cost cap is a spend and is read separately. */
export type QuotaCountResource = 'assets' | 'concurrent_runs' | 'members';

/** Reads and locks the tenant's quota state inside the caller's transaction. */
export class QuotaUsageRepository {
  /**
   * Serialises concurrent creations of one resource in one tenant for the rest of the transaction. Two
   * creates at the boundary cannot both count the same free slot (TOCTOU, §8.6). The lock key is the tenant
   * and the resource, so unrelated resources and other tenants never wait on each other.
   */
  async lockResource(tx: TenantTx, tenantId: string, resource: QuotaCountResource): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${tenantId}:${resource}`}, 0))`,
    );
  }

  /** The tenant's plan name, or `undefined` for a tenant this transaction cannot see. */
  async planOf(tx: TenantTx, tenantId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ plan: tenants.plan })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return rows[0]?.plan;
  }

  /** The roles the user holds in the tenant (empty when the user is not a member). */
  async rolesOf(tx: TenantTx, tenantId: string, userId: string): Promise<readonly string[]> {
    const rows = await tx
      .select({ roles: memberships.roles })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1);
    return rows[0]?.roles ?? [];
  }

  /** Live (not soft-deleted) assets of the tenant. */
  async countAssets(tx: TenantTx, tenantId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assets)
      .where(and(eq(assets.tenantId, tenantId), isNull(assets.deletedAt)));
    return row?.n ?? 0;
  }

  /** Runs of the tenant that hold a concurrency slot: every state except the terminal ones. */
  async countConcurrentRuns(tx: TenantTx, tenantId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.tenantId, tenantId), notInArray(runs.state, [...TERMINAL_RUN_STATES])));
    return row?.n ?? 0;
  }

  /** Memberships of the tenant. A membership with no roles still counts: it is a seat. */
  async countMembers(tx: TenantTx, tenantId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.tenantId, tenantId));
    return row?.n ?? 0;
  }

  /**
   * Month-to-date spend from the append-only ledger over `[monthStart, monthEnd)`. The sum is returned as a
   * float for the USD comparison; the ledger itself stores exact `numeric` values.
   */
  async monthlyCostUsd(
    tx: TenantTx,
    tenantId: string,
    monthStart: Date,
    monthEnd: Date,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)::float8` })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.tenantId, tenantId),
          gte(costLedger.occurredAt, monthStart),
          lt(costLedger.occurredAt, monthEnd),
        ),
      );
    return row?.total ?? 0;
  }
}
