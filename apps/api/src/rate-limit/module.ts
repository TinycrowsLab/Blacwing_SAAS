import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RateLimitGuard } from './guard.js';
import { InProcessRateLimiter, type RateLimiter } from './limiter.js';
import { createRateLimitMetrics } from './metrics.js';
import { RateLimitPolicy, type RateLimitConfig } from './policy.js';
import {
  IN_PROCESS_RATE_LIMITER,
  RATE_LIMIT_METRICS,
  RATE_LIMIT_POLICY,
  RATE_LIMITER,
} from './tokens.js';
import { API_CONFIG } from '../bootstrap/tokens.js';

import type { ApiConfig } from '../config.js';
import type { Registry } from 'prom-client';

interface RateLimitModuleOptions {
  /** Registry the `rate_limit_*` metrics live on. */
  readonly registry: Registry;
  /** The shared limiter (`ValkeyRateLimiter` in production). Absent: the in-process limiter only, per instance. */
  readonly limiter?: RateLimiter;
  /** Per-plan and per-route-class limit values (TENANT-011). Absent: the env fallback applies to every bucket. */
  readonly config?: RateLimitConfig;
}

/** Installs the global rate-limit guard (API-rate-limit). Import it after `TenantContextModule`: the guard keys on the tenant. */
@Global()
@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions): DynamicModule {
    return {
      module: RateLimitModule,
      providers: [
        {
          provide: RATE_LIMIT_POLICY,
          inject: [API_CONFIG],
          useFactory: (config: Readonly<ApiConfig>): RateLimitPolicy =>
            new RateLimitPolicy({
              defaults: { rps: config.RATE_LIMIT_DEFAULT_RPS, burst: config.RATE_LIMIT_BURST },
              ...(options.config === undefined ? {} : { config: options.config }),
            }),
        },
        {
          provide: IN_PROCESS_RATE_LIMITER,
          useFactory: (): RateLimiter => new InProcessRateLimiter(),
        },
        {
          provide: RATE_LIMITER,
          inject: [IN_PROCESS_RATE_LIMITER],
          useFactory: (fallback: RateLimiter): RateLimiter => options.limiter ?? fallback,
        },
        { provide: RATE_LIMIT_METRICS, useFactory: () => createRateLimitMetrics(options.registry) },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    };
  }
}
