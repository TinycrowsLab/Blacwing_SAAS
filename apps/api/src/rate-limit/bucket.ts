import type { RateLimitScope, RateLimitValues } from './policy.js';

const MS_PER_SECOND = 1000;

/** One bucket a request is charged against. */
export interface BucketSpec extends RateLimitValues {
  /** Tenant-prefixed Valkey key (`rl:{tenantId}:...`) or the reserved anonymous key. */
  readonly key: string;
  readonly scope: RateLimitScope;
}

/** A request is charged against one or more buckets; with several (principal and tenant), all must admit it. */
export type BucketSpecs = readonly [BucketSpec, ...BucketSpec[]];

/** A bucket as stored: tokens left at `updatedAtMs`. */
export interface BucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

/** The outcome of one check, in the shape the guard turns into headers and a 429. */
export interface BucketDecision {
  readonly allowed: boolean;
  /** Burst of the bucket with the fewest tokens left. */
  readonly limit: number;
  /** Whole tokens left in that bucket after this check. */
  readonly remaining: number;
  /** Whole seconds until every bucket is full again (`RateLimit-Reset`). */
  readonly resetSeconds: number;
  /** Whole seconds until one more token is available (`Retry-After`); 0 when allowed. */
  readonly retryAfterSeconds: number;
  /** Scope of the first empty bucket, when denied. */
  readonly blockedBy?: RateLimitScope;
}

export interface BucketEvaluation {
  readonly decision: BucketDecision;
  /** The state to store for every bucket of the check. */
  readonly next: ReadonlyMap<string, BucketState>;
}

/**
 * Token-bucket arithmetic, shared by the in-process fallback and mirrored by the Valkey Lua script
 * (`valkey-limiter.ts`). A bucket refills at `rps` tokens per second up to `burst`. A request is admitted only
 * when every bucket holds a whole token; then each is charged one token. A denied check still stores the
 * refilled state, so reset and retry figures stay accurate.
 */
export function evaluateBuckets(
  specs: BucketSpecs,
  nowMs: number,
  stored: (key: string) => BucketState | undefined,
): BucketEvaluation {
  const refilled = specs.map((spec) => {
    const prior = stored(spec.key);
    const tokens =
      prior === undefined
        ? spec.burst
        : // A clock that moved backwards must not mint tokens: elapsed time never goes below zero.
          Math.min(
            spec.burst,
            prior.tokens + (Math.max(0, nowMs - prior.updatedAtMs) * spec.rps) / MS_PER_SECOND,
          );
    return { spec, tokens };
  });
  const allowed = refilled.every((row) => row.tokens >= 1);
  const after = refilled.map((row) => ({
    spec: row.spec,
    before: row.tokens,
    tokens: allowed ? row.tokens - 1 : row.tokens,
  }));

  const next = new Map<string, BucketState>();
  for (const row of after) next.set(row.spec.key, { tokens: row.tokens, updatedAtMs: nowMs });

  const tightest = after.reduce((best, row) => (row.tokens < best.tokens ? row : best));
  const empty = after.filter((row) => row.before < 1);
  const retryMs = Math.max(
    0,
    ...empty.map((row) => ((1 - row.before) * MS_PER_SECOND) / row.spec.rps),
  );
  const resetMs = Math.max(
    0,
    ...after.map((row) => ((row.spec.burst - row.tokens) * MS_PER_SECOND) / row.spec.rps),
  );
  const firstEmpty = empty[0];

  return {
    decision: {
      allowed,
      limit: tightest.spec.burst,
      remaining: Math.floor(tightest.tokens),
      resetSeconds: Math.ceil(resetMs / MS_PER_SECOND),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retryMs / MS_PER_SECOND)),
      ...(firstEmpty === undefined ? {} : { blockedBy: firstEmpty.spec.scope }),
    },
    next,
  };
}
