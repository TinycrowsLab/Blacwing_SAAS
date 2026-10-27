import {
  evaluateBuckets,
  type BucketDecision,
  type BucketEvaluation,
  type BucketSpecs,
  type BucketState,
} from './bucket.js';

/** Charges one request against its buckets. Implementations: Valkey (shared) and in-process (per instance). */
export interface RateLimiter {
  consume(specs: BucketSpecs): Promise<BucketDecision>;
}

interface InProcessRateLimiterOptions {
  /** Clock in milliseconds; injectable for tests. */
  readonly now?: () => number;
  /** Most buckets held at once. At the cap, idle buckets are dropped first; a still-unknown key is denied. */
  readonly maxBuckets?: number;
}

const DEFAULT_MAX_BUCKETS = 10_000;
const MS_PER_SECOND = 1000;

interface StoredBucket extends BucketState {
  readonly rps: number;
  readonly burst: number;
}

/**
 * The conservative fallback limiter: the same token-bucket arithmetic, held in this process. It is used when
 * Valkey is unreachable (`rate_limit.degraded`) and when no shared limiter is configured. Limits are per
 * instance, so they are looser than the Valkey ones across N instances; a bounded map keeps memory fixed.
 */
export class InProcessRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, StoredBucket>();
  readonly #now: () => number;
  readonly #maxBuckets: number;

  constructor(options: InProcessRateLimiterOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  }

  consume(specs: BucketSpecs): Promise<BucketDecision> {
    const nowMs = this.#now();
    if (this.#buckets.size >= this.#maxBuckets) this.#dropIdle(nowMs);
    const unknownAtCap =
      this.#buckets.size >= this.#maxBuckets && specs.some((spec) => !this.#buckets.has(spec.key));
    if (unknownAtCap) {
      // Refusing a new key is the conservative choice: an attacker cannot evict honest buckets to get past.
      return Promise.resolve({
        allowed: false,
        limit: specs[0].burst,
        remaining: 0,
        resetSeconds: 1,
        retryAfterSeconds: 1,
        blockedBy: specs[0].scope,
      });
    }
    const evaluation: BucketEvaluation = evaluateBuckets(specs, nowMs, (key) =>
      this.#buckets.get(key),
    );
    for (const spec of specs) {
      const state = evaluation.next.get(spec.key);
      if (state !== undefined)
        this.#buckets.set(spec.key, { ...state, rps: spec.rps, burst: spec.burst });
    }
    return Promise.resolve(evaluation.decision);
  }

  /** Drops buckets that have refilled to full: forgetting them changes nothing. */
  #dropIdle(nowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      const refilled =
        bucket.tokens + (Math.max(0, nowMs - bucket.updatedAtMs) * bucket.rps) / MS_PER_SECOND;
      if (refilled >= bucket.burst) this.#buckets.delete(key);
    }
  }
}
