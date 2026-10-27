import { SetMetadata } from '@nestjs/common';
import { z } from 'zod';

/** Metadata key of {@link RateLimit} (per-route overrides). */
export const RATE_LIMIT_KEY = Symbol.for('blackwing.api.rate-limit');
/** Metadata key of {@link RateLimitExempt} (health and internal routes). */
export const RATE_LIMIT_EXEMPT_KEY = Symbol.for('blackwing.api.rate-limit.exempt');

/** Route class of every route that does not name one. */
export const DEFAULT_ROUTE_CLASS = 'default';

/**
 * Whose bucket a request is charged to: the calling token or user (`principal`), the tenant ceiling shared by
 * all of its principals (`tenant`), or the client IP of an unauthenticated request (`ip`).
 */
export type RateLimitScope = 'principal' | 'tenant' | 'ip';

/** Sustained rate (tokens refilled per second) and burst (bucket capacity). */
export interface RateLimitValues {
  readonly rps: number;
  readonly burst: number;
}

/** What {@link RateLimitConfig.limitsFor} is asked for. */
interface RateLimitLookup {
  readonly scope: RateLimitScope;
  readonly routeClass: string;
  /** Absent for unauthenticated (`ip`) requests. */
  readonly tenantId: string | undefined;
}

/**
 * Per-plan and per-route-class limit values (TENANT-011 supplies them; this module only reads them). Return
 * `undefined` for "not configured": the mechanism fallback `RATE_LIMIT_DEFAULT_RPS` / `RATE_LIMIT_BURST` applies.
 */
export interface RateLimitConfig {
  readonly limitsFor: (lookup: RateLimitLookup) => RateLimitValues | undefined;
}

/** Options of {@link RateLimit}: a route class and/or values overriding the principal or IP limit. */
export interface RateLimitOptions {
  readonly routeClass?: string | undefined;
  readonly rps?: number | undefined;
  readonly burst?: number | undefined;
}

const RATE_LIMIT_OPTIONS = z
  .object({
    routeClass: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'must be a lower-case route class name')
      .optional(),
    rps: z.number().int().positive().optional(),
    burst: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Overrides the limit of the route it decorates (principal or IP scope; the tenant ceiling is never overridden).
 * Options are checked when the module loads: a misspelt or non-positive value refuses to boot.
 */
export const RateLimit = (options: RateLimitOptions = {}): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, RATE_LIMIT_OPTIONS.parse(options));

/** Exempts a controller or handler from rate limiting: health probes and internal routes only. */
export const RateLimitExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_EXEMPT_KEY, true);

/**
 * Resolves the limit of one bucket: the override of the route (principal and IP scopes), else the configured
 * value from `TENANT-011`'s {@link RateLimitConfig}, else the env fallback.
 */
export class RateLimitPolicy {
  readonly #defaults: RateLimitValues;
  readonly #config: RateLimitConfig | undefined;

  constructor(options: { readonly defaults: RateLimitValues; readonly config?: RateLimitConfig }) {
    this.#defaults = options.defaults;
    this.#config = options.config;
  }

  limitsFor(lookup: RateLimitLookup, override?: RateLimitOptions): RateLimitValues {
    const base = this.#config?.limitsFor(lookup) ?? this.#defaults;
    if (override === undefined || lookup.scope === 'tenant') return base;
    return {
      rps: override.rps ?? base.rps,
      burst: override.burst ?? base.burst,
    };
  }
}
