/** DI token of the `RateLimitPolicy` (per-scope limit resolution with the env fallback). */
export const RATE_LIMIT_POLICY = Symbol.for('blackwing.api.rate-limit.policy');

/** DI token of the shared `RateLimiter` (Valkey in production; the in-process limiter otherwise). */
export const RATE_LIMITER = Symbol.for('blackwing.api.rate-limit.limiter');

/** DI token of the in-process fallback limiter, used when the shared one fails. */
export const IN_PROCESS_RATE_LIMITER = Symbol.for('blackwing.api.rate-limit.in-process');

/** DI token of the rate-limit metrics. */
export const RATE_LIMIT_METRICS = Symbol.for('blackwing.api.rate-limit.metrics');
