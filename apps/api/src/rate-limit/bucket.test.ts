import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type BucketSpec, type BucketSpecs, type BucketState, evaluateBuckets } from './bucket.js';

const T0 = 1_700_000_000_000;

function spec(overrides: Partial<BucketSpec> = {}): BucketSpec {
  return { key: 'rl:t:p:default', scope: 'principal', rps: 1, burst: 3, ...overrides };
}

function run(specs: BucketSpecs, nowMs: number, stored: Record<string, BucketState> = {}) {
  return evaluateBuckets(specs, nowMs, (key) => stored[key]);
}

describe('evaluateBuckets', () => {
  it('starts a fresh bucket full and charges one token on admission', () => {
    const { decision, next } = run([spec()], T0);
    expect(decision).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetSeconds: 1,
      retryAfterSeconds: 0,
    });
    expect(next.get('rl:t:p:default')).toEqual({ tokens: 2, updatedAtMs: T0 });
  });

  it('refills at rps per second and never above burst', () => {
    const empty = { tokens: 0, updatedAtMs: T0 };
    expect(
      run([spec({ rps: 2, burst: 10 })], T0 + 1500, { 'rl:t:p:default': empty }).decision.remaining,
    ).toBe(2);
    // A long idle period refills to burst, not beyond it.
    const later = run([spec({ rps: 2, burst: 10 })], T0 + 10_000_000, { 'rl:t:p:default': empty });
    expect(later.decision.remaining).toBe(9);
    // One token charged out of 10 at 2 rps: the bucket is full again within half a second, rounded up.
    expect(later.decision.resetSeconds).toBe(1);
  });

  it('denies an empty bucket with Retry-After of at least one whole second, and charges nothing', () => {
    const stored = { 'rl:t:p:default': { tokens: 0.4, updatedAtMs: T0 } };
    const { decision, next } = run([spec({ rps: 1 })], T0, stored);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
    expect(decision.blockedBy).toBe('principal');
    // The refilled (not charged) state is stored, so the reset figure stays accurate.
    expect(next.get('rl:t:p:default')).toEqual({ tokens: 0.4, updatedAtMs: T0 });
  });

  it('rounds Retry-After up to whole seconds, with at least one', () => {
    // Empty at 2 rps: the next token is 500 ms away, reported as 1 s.
    const empty = { 'rl:t:p:default': { tokens: 0, updatedAtMs: T0 } };
    expect(run([spec({ rps: 2 })], T0, empty).decision.retryAfterSeconds).toBe(1);
    // Nearly a token at 1 rps: 100 ms away, still reported as 1 s.
    const almost = { 'rl:t:p:default': { tokens: 0.9, updatedAtMs: T0 } };
    expect(run([spec({ rps: 1 })], T0, almost).decision.retryAfterSeconds).toBe(1);
  });

  it('never mints tokens when the clock moves backwards', () => {
    const stored = { 'rl:t:p:default': { tokens: 0.2, updatedAtMs: T0 + 5000 } };
    const { decision } = run([spec({ rps: 10 })], T0, stored);
    expect(decision.allowed).toBe(false);
  });

  it('admits at exactly one whole token and denies just below it', () => {
    const exact = { 'rl:t:p:default': { tokens: 0, updatedAtMs: T0 } };
    expect(run([spec({ rps: 1 })], T0 + 1000, exact).decision.allowed).toBe(true);
    expect(run([spec({ rps: 1 })], T0 + 999, exact).decision.allowed).toBe(false);
  });

  it('smooths the window edge: a burst straddling a second boundary is not doubled', () => {
    // burst 5, rps 5: five requests at T0+999 empty the bucket; one millisecond later no token exists yet.
    const first = run([spec({ rps: 5, burst: 5 })], T0 + 999);
    expect(first.decision.allowed).toBe(true);
    let state = Object.fromEntries(first.next);
    let admitted = 1;
    for (let i = 1; i < 5; i += 1) {
      const next = run([spec({ rps: 5, burst: 5 })], T0 + 999, state);
      if (next.decision.allowed) admitted += 1;
      state = Object.fromEntries(next.next);
    }
    const edge = run([spec({ rps: 5, burst: 5 })], T0 + 1000, state);
    expect(admitted).toBe(5);
    expect(edge.decision.allowed).toBe(false);
  });

  it('admits only when every bucket has a token, and reports the scope of the first empty one', () => {
    const principal = spec({ key: 'rl:t:alice:default', scope: 'principal', burst: 5 });
    const tenant = spec({ key: 'rl:t:_tenant:default', scope: 'tenant', burst: 1 });
    const stored = { 'rl:t:_tenant:default': { tokens: 0, updatedAtMs: T0 } };
    const { decision, next } = run([principal, tenant], T0, stored);
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toBe('tenant');
    // The principal bucket is not charged for a request the tenant ceiling refused.
    expect(next.get('rl:t:alice:default')?.tokens).toBe(5);
  });

  it('reports the bucket with the fewest tokens as the limit and remaining', () => {
    const roomy = spec({ key: 'a', scope: 'tenant', burst: 100 });
    const tight = spec({ key: 'b', scope: 'principal', burst: 4 });
    const { decision } = run([roomy, tight], T0);
    expect(decision).toMatchObject({ allowed: true, limit: 4, remaining: 3 });
  });

  it('property: over any span, admitted requests never exceed burst plus rps times the span', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 200 }),
        (rps, burst, gaps) => {
          let now = T0;
          let state: Record<string, BucketState> = {};
          let admitted = 0;
          for (const gap of gaps) {
            now += gap;
            const result = run([spec({ rps, burst })], now, state);
            if (result.decision.allowed) admitted += 1;
            state = Object.fromEntries(result.next);
          }
          const spanSeconds = (now - T0) / 1000;
          return admitted <= burst + rps * spanSeconds + 1e-9;
        },
      ),
    );
  });
});
