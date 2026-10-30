/** The result of one quota check: whether the request fits, and the numbers the caller reports. */
export interface QuotaDecision {
  readonly allowed: boolean;
  /** `null` when the resource is unlimited on this plan. */
  readonly limit: number | null;
  /** Current usage: a count for count resources, USD for the cost cap. */
  readonly used: number;
}

/**
 * Count quotas: `requested` more items fit when `used + requested <= limit`. A `null` limit always fits.
 * Usage above the limit (after a plan downgrade) blocks new creation until the tenant is back under it.
 */
export function evaluateCountQuota(
  limit: number | null,
  used: number,
  requested: number,
): QuotaDecision {
  if (!Number.isSafeInteger(used) || used < 0) throw new RangeError('used must be a count >= 0');
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new RangeError('requested must be a count >= 1');
  }
  if (limit === null) return { allowed: true, limit, used };
  return { allowed: used + requested <= limit, limit, used };
}

/**
 * The monthly cost cap: new work is refused once month-to-date spend has reached the cap (`used >= cap`).
 * The cap is a ceiling on spend, not on a request, so no requested amount is added here.
 */
export function evaluateCostCap(capUsd: number | null, usedUsd: number): QuotaDecision {
  if (!Number.isFinite(usedUsd) || usedUsd < 0) throw new RangeError('used cost must be >= 0');
  if (capUsd === null) return { allowed: true, limit: null, used: usedUsd };
  return { allowed: usedUsd < capUsd, limit: capUsd, used: usedUsd };
}

/** The [start, end) bounds of the calendar month that contains `now`, in UTC (§5). */
export function utcMonthBounds(now: Date): { readonly start: Date; readonly end: Date } {
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid date');
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}
