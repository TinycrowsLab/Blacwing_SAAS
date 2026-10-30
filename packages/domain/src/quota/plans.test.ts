import { describe, expect, it } from 'vitest';

import { evaluateCostCap, evaluateCountQuota, utcMonthBounds } from './evaluate.js';
import { PLAN_CATALOGUE, limitFor, planLimits, UnknownPlanError } from './plans.js';

describe('plan catalogue', () => {
  it('pins the explicit numeric defaults', () => {
    expect(PLAN_CATALOGUE.free).toEqual({
      maxAssets: 3,
      maxConcurrentRuns: 1,
      maxMembers: 3,
      monthlyCostCapUsd: 50,
    });
  });

  it('represents enterprise as unlimited (null)', () => {
    expect(planLimits('enterprise')).toEqual({
      maxAssets: null,
      maxConcurrentRuns: null,
      maxMembers: null,
      monthlyCostCapUsd: null,
    });
  });

  it('refuses an unknown plan instead of falling back to unlimited', () => {
    expect(() => planLimits('gold')).toThrow(UnknownPlanError);
    expect(() => planLimits('')).toThrow(UnknownPlanError);
  });

  it('maps each resource to its limit', () => {
    const free = planLimits('free');
    expect(limitFor(free, 'assets')).toBe(3);
    expect(limitFor(free, 'concurrent_runs')).toBe(1);
    expect(limitFor(free, 'members')).toBe(3);
    expect(limitFor(free, 'monthly_cost')).toBe(50);
  });
});

describe('count quota', () => {
  it('allows creation while used + requested <= limit', () => {
    expect(evaluateCountQuota(3, 2, 1)).toEqual({ allowed: true, limit: 3, used: 2 });
  });

  it('blocks the create that would reach past the limit', () => {
    expect(evaluateCountQuota(3, 3, 1)).toEqual({ allowed: false, limit: 3, used: 3 });
    expect(evaluateCountQuota(3, 2, 2).allowed).toBe(false);
  });

  it('blocks everything when grandfathered usage exceeds a downgraded limit', () => {
    expect(evaluateCountQuota(1, 4, 1).allowed).toBe(false);
  });

  it('always allows an unlimited resource', () => {
    expect(evaluateCountQuota(null, 1_000_000, 1)).toEqual({
      allowed: true,
      limit: null,
      used: 1_000_000,
    });
  });

  it('rejects malformed counts', () => {
    expect(() => evaluateCountQuota(3, -1, 1)).toThrow(RangeError);
    expect(() => evaluateCountQuota(3, 1.5, 1)).toThrow(RangeError);
    expect(() => evaluateCountQuota(3, 1, 0)).toThrow(RangeError);
  });
});

describe('monthly cost cap', () => {
  it('blocks new work once spend reaches the cap', () => {
    expect(evaluateCostCap(50, 49.99).allowed).toBe(true);
    expect(evaluateCostCap(50, 50).allowed).toBe(false);
  });

  it('is unlimited for a null cap', () => {
    expect(evaluateCostCap(null, 9999).allowed).toBe(true);
  });

  it('rejects negative or non-finite spend', () => {
    expect(() => evaluateCostCap(50, -0.01)).toThrow(RangeError);
    expect(() => evaluateCostCap(50, Number.NaN)).toThrow(RangeError);
  });
});

describe('utcMonthBounds', () => {
  it('uses the UTC calendar month, not the local one', () => {
    const { start, end } = utcMonthBounds(new Date('2026-10-31T23:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('starts the next month exactly at the boundary', () => {
    const { start } = utcMonthBounds(new Date('2026-11-01T00:00:00.000Z'));
    expect(start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('rolls over the year in December', () => {
    const { end } = utcMonthBounds(new Date('2026-12-15T12:00:00.000Z'));
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects an invalid date', () => {
    expect(() => utcMonthBounds(new Date('nope'))).toThrow(RangeError);
  });
});
