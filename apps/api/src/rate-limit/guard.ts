import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { trace } from '@opentelemetry/api';

import { hashTenantId } from '@blackwing/db/tenant-context';
import { RateLimitedError, serializeErrorForLog } from '@blackwing/errors';

import {
  DEFAULT_ROUTE_CLASS,
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_KEY,
  type RateLimitOptions,
  type RateLimitPolicy,
} from './policy.js';
import {
  IN_PROCESS_RATE_LIMITER,
  RATE_LIMIT_METRICS,
  RATE_LIMIT_POLICY,
  RATE_LIMITER,
} from './tokens.js';
import { requestLogger } from '../bootstrap/request-context.js';
import { API_LOGGER } from '../bootstrap/tokens.js';
import { isEntryPoint, replyOf, requestOf } from '../bootstrap/transport.js';
import { tenantContextOf } from '../tenant/guard.js';

import type { BucketDecision, BucketSpec, BucketSpecs } from './bucket.js';
import type { RateLimiter } from './limiter.js';
import type { RateLimitMetrics } from './metrics.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyRequest } from 'fastify';

/** Tracer name of the rate-limit check span (`ratelimit.check`). */
const TRACER_NAME = '@blackwing/api.rate-limit';
const MS_PER_SECOND = 1000;

/** Keys of anonymous (unauthenticated) traffic: a reserved prefix no tenant key can collide with. */
const ANONYMOUS_PREFIX = 'rl:_anon:ip';

/**
 * Global guard (APP_GUARD, mounted after the tenant guard): charges every request to its token or user bucket
 * and to the tenant ceiling, or to the client IP bucket when there is no tenant. Both must admit the request
 * (the stricter wins). On a denial it throws `RATE_LIMITED` (429 with `Retry-After`). Health and internal
 * routes are `@RateLimitExempt()`.
 *
 * Fails open: when the shared limiter errors, the request is decided by the in-process fallback and
 * `rate_limit.degraded` is logged, so the control plane does not hard-fail on a cache outage.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_LOGGER) private readonly logger: Logger,
    @Inject(RATE_LIMIT_POLICY) private readonly policy: RateLimitPolicy,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(IN_PROCESS_RATE_LIMITER) private readonly fallback: RateLimiter,
    @Inject(RATE_LIMIT_METRICS) private readonly metrics: RateLimitMetrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handlers = [context.getHandler(), context.getClass()] as const;
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(RATE_LIMIT_EXEMPT_KEY, [
        ...handlers,
      ]) === true
    )
      return true;
    // HTTP and GraphQL operations are both charged; other transports are not rate limited here.
    const request = requestOf(context);
    if (request === undefined || !isEntryPoint(context)) return true;

    const override = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      [...handlers],
    );
    const routeClass = override?.routeClass ?? DEFAULT_ROUTE_CLASS;
    const reply = replyOf(context);
    const specs = this.specsFor(request, routeClass, override);
    const decision = await this.decide(specs);

    if (reply !== undefined) {
      void reply.header('RateLimit-Limit', String(decision.limit));
      void reply.header('RateLimit-Remaining', String(decision.remaining));
      void reply.header('RateLimit-Reset', String(decision.resetSeconds));
    }
    if (decision.allowed) return true;

    // A denial always names the empty bucket; the fallback label only satisfies the type.
    const blockedBy = decision.blockedBy ?? 'principal';
    this.metrics.blocked.inc({ routeClass, scope: blockedBy });
    this.logBlocked(request, routeClass, decision);
    throw new RateLimitedError('rate limit exceeded', {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  /** The buckets this request is charged against (see the module comment for the key scheme). */
  private specsFor(
    request: FastifyRequest,
    routeClass: string,
    override: RateLimitOptions | undefined,
  ): BucketSpecs {
    const tenant = tenantContextOf(request);
    if (tenant === undefined) {
      // `request.ip` honours X-Forwarded-For only behind a trusted proxy (API_TRUST_PROXY).
      return [
        this.spec(
          `${ANONYMOUS_PREFIX}:${request.ip}:${routeClass}`,
          'ip',
          this.policy.limitsFor({ scope: 'ip', routeClass, tenantId: undefined }, override),
        ),
      ];
    }
    const { tenantId } = tenant;
    return [
      this.spec(
        `rl:${tenantId}:${tenant.actor.id}:${routeClass}`,
        'principal',
        this.policy.limitsFor({ scope: 'principal', routeClass, tenantId }, override),
      ),
      this.spec(
        `rl:${tenantId}:_tenant:${routeClass}`,
        'tenant',
        this.policy.limitsFor({ scope: 'tenant', routeClass, tenantId }),
      ),
    ];
  }

  private spec(
    key: string,
    scope: BucketSpec['scope'],
    values: { readonly rps: number; readonly burst: number },
  ): BucketSpec {
    return { key, scope, rps: values.rps, burst: values.burst };
  }

  /** The shared limiter decides; on its failure the in-process fallback decides, and the degradation is logged. */
  private async decide(specs: BucketSpecs): Promise<BucketDecision> {
    const span = trace.getTracer(TRACER_NAME).startSpan('ratelimit.check');
    const started = performance.now();
    try {
      return await this.limiter.consume(specs);
    } catch (error) {
      this.metrics.degraded.inc();
      this.logger.warn({ err: serializeErrorForLog(error) }, 'rate_limit.degraded');
      return await this.fallback.consume(specs);
    } finally {
      this.metrics.checkDuration.observe((performance.now() - started) / MS_PER_SECOND);
      span.end();
    }
  }

  private logBlocked(request: FastifyRequest, routeClass: string, decision: BucketDecision): void {
    const tenant = tenantContextOf(request);
    requestLogger(this.logger).info(
      {
        'rl.tenant': tenant === undefined ? undefined : hashTenantId(tenant.tenantId),
        'rl.principal': tenant === undefined ? 'anonymous' : tenant.actor.id,
        'rl.routeClass': routeClass,
        'rl.remaining': decision.remaining,
        'rl.scope': decision.blockedBy,
        decision: 'deny',
      },
      'rate_limit.blocked',
    );
  }
}
