/**
 * Subscription plan catalogue and per-tenant quotas (TENANT-009, CONTEXT_PACK §7, §8.11). v1 has plans and
 * quotas only: no billing. `tenants.plan` selects one entry. A `null` limit means unlimited (enterprise), and
 * the enforcement check is skipped for it.
 */

export const PLAN_NAMES = ['free', 'pro', 'enterprise'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

/** The resources a plan limits. Each one is counted at the point where it is created. */
export const QUOTA_RESOURCES = ['assets', 'concurrent_runs', 'members', 'monthly_cost'] as const;
export type QuotaResource = (typeof QUOTA_RESOURCES)[number];

export interface PlanLimits {
  readonly maxAssets: number | null;
  readonly maxConcurrentRuns: number | null;
  readonly maxMembers: number | null;
  /** Monthly cost cap in USD, measured over the current calendar month in UTC (§5). */
  readonly monthlyCostCapUsd: number | null;
}

/** Explicit defaults. Changing a number here is a product decision, so the tests pin them. */
export const PLAN_CATALOGUE: Readonly<Record<PlanName, PlanLimits>> = Object.freeze({
  free: { maxAssets: 3, maxConcurrentRuns: 1, maxMembers: 3, monthlyCostCapUsd: 50 },
  pro: { maxAssets: 50, maxConcurrentRuns: 5, maxMembers: 25, monthlyCostCapUsd: 1000 },
  enterprise: {
    maxAssets: null,
    maxConcurrentRuns: null,
    maxMembers: null,
    monthlyCostCapUsd: null,
  },
});

export function isPlanName(value: string): value is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(value);
}

/** The limits of a plan name. Throws on an unknown name: an unknown plan must never fall back to "unlimited". */
export function planLimits(plan: string): PlanLimits {
  if (!isPlanName(plan)) throw new UnknownPlanError(plan);
  return PLAN_CATALOGUE[plan];
}

export class UnknownPlanError extends Error {
  constructor(readonly plan: string) {
    super('unknown subscription plan');
    this.name = 'UnknownPlanError';
  }
}

/** The limit of one resource under a plan (`null` means unlimited). */
export function limitFor(limits: PlanLimits, resource: QuotaResource): number | null {
  switch (resource) {
    case 'assets':
      return limits.maxAssets;
    case 'concurrent_runs':
      return limits.maxConcurrentRuns;
    case 'members':
      return limits.maxMembers;
    case 'monthly_cost':
      return limits.monthlyCostCapUsd;
  }
}
