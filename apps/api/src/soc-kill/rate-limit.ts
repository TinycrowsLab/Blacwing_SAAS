import { type Clock, systemClock } from '@blackwing/time';

import type { RateLimitVerdict, RateLimiter } from './ports.js';

const MS_PER_SECOND = 1000;
/** Bounds memory: more live buckets than this and new keys are refused (fail closed). */
const DEFAULT_MAX_KEYS = 10_000;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window limiter, per process. With N API replicas the effective limit is N times higher;
 * the {@link RateLimiter} port lets a shared store replace it without touching the service.
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {}

  hit(key: string, limit: number, windowMs: number): RateLimitVerdict {
    const now = this.clock.now().getTime();
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      if (this.buckets.size >= this.maxKeys) {
        return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / MS_PER_SECOND) };
      }
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / MS_PER_SECOND)),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}
