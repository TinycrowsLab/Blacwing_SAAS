import { type DynamicModule, Global, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { tenantPrincipalFromRequest } from './auth/guard.js';
import { AuthModule, type AuthOptions } from './auth/module.js';
import { createHttpMetrics, type HttpMetrics } from './bootstrap/metrics.js';
import {
  API_CONFIG,
  API_LOGGER,
  API_METRICS,
  API_SECURITY_EVENT_SINK,
} from './bootstrap/tokens.js';
import { ProblemJsonExceptionFilter, type SecurityEventSink } from './errors/problem-filter.js';
import { HealthModule } from './health/health.module.js';
import { IdempotencyModule } from './idempotency/module.js';
import { RateLimitModule } from './rate-limit/module.js';
import { SmokeController } from './smoke.controller.js';
import { TenantContextModule } from './tenant/module.js';
import { createValidationPipe } from './validation/zod-validation.pipe.js';

import type { ApiConfig } from './config.js';
import type { HealthProbe } from './health/health.types.js';
import type { IdempotencyStore } from './idempotency/ports.js';
import type { RateLimiter } from './rate-limit/limiter.js';
import type { RateLimitConfig } from './rate-limit/policy.js';
import type { TenantPrincipalSource } from './tenant/guard.js';
import type { Logger } from '@blackwing/logger';

/** Provides the validated, frozen `ApiConfig` (from `@blackwing/config`) under `API_CONFIG`. */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: Readonly<ApiConfig>): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}

/** Provides the root `@blackwing/logger` logger under `API_LOGGER`. */
@Global()
@Module({})
export class LoggerModule {
  static forRoot(logger: Logger): DynamicModule {
    return {
      module: LoggerModule,
      providers: [{ provide: API_LOGGER, useValue: logger }],
      exports: [API_LOGGER],
    };
  }
}

export interface AppModuleOptions {
  readonly config: Readonly<ApiConfig>;
  readonly logger: Logger;
  /** Metrics of this app instance; a private set is created when omitted. */
  readonly metrics?: HttpMetrics;
  /** Dependencies the health endpoints check (postgresProbe, valkeyProbe, ...). */
  readonly healthProbes?: readonly HealthProbe[];
  /**
   * Store behind `@Idempotent()` routes (API-008): the Valkey adapter in production. Without one those
   * routes answer `503 idempotency_unavailable` (fail closed).
   */
  readonly idempotencyStore?: IdempotencyStore;
  /**
   * The global auth guard's credential validators (#335). When set, every route not marked `@PublicRoute()`
   * must present a valid credential, and the tenant comes from the principal that guard attached. Mutually
   * exclusive with `tenantPrincipalSource`.
   */
  readonly auth?: AuthOptions;
  /**
   * IAM's validated-principal lookup (TENANT-003). When set, a global guard and interceptor make every
   * route not marked `@PublicRoute()` tenant-scoped: no principal is 401, no resolvable tenant is
   * `403 tenant_context_missing`, and the handler runs inside the `AsyncLocalStorage` tenant context.
   * Without `auth` and without this, no tenant guard is installed (tests and the bare app only).
   */
  readonly tenantPrincipalSource?: TenantPrincipalSource;
  /** Receives security-relevant errors (`permission_denied`, `tenant_context_missing`); AUDIT wires `emitAudit`. */
  readonly securityEventSink?: SecurityEventSink;
  /**
   * Shared limiter behind the rate-limit guard (Valkey in production). Absent: an in-process limiter per instance.
   */
  readonly rateLimiter?: RateLimiter;
  /** Per-plan and per-route-class limit values (TENANT-011). Absent: the env fallback applies. */
  readonly rateLimitConfig?: RateLimitConfig;
  /** Extra modules to mount (feature modules of later issues; test-only routes). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
}

/** Root module of the control-plane API. */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    if (options.auth !== undefined && options.tenantPrincipalSource !== undefined) {
      throw new Error('set either auth or tenantPrincipalSource, not both');
    }
    const metrics = options.metrics ?? createHttpMetrics();
    const principalSource =
      options.auth === undefined ? options.tenantPrincipalSource : tenantPrincipalFromRequest;
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggerModule.forRoot(options.logger),
        HealthModule.forRoot({
          registry: metrics.registry,
          ...(options.healthProbes === undefined ? {} : { probes: options.healthProbes }),
        }),
        IdempotencyModule.forRoot({
          registry: metrics.registry,
          ...(options.idempotencyStore === undefined ? {} : { store: options.idempotencyStore }),
        }),
        // Before the tenant module: APP_GUARD order makes the auth guard run before tenant resolution.
        ...(options.auth === undefined ? [] : [AuthModule.forRoot(options.auth)]),
        ...(principalSource === undefined
          ? []
          : [TenantContextModule.forRoot({ principalSource, registry: metrics.registry })]),
        // After the tenant module: APP_GUARD order makes the limiter run once the tenant is resolved.
        RateLimitModule.forRoot({
          registry: metrics.registry,
          ...(options.rateLimiter === undefined ? {} : { limiter: options.rateLimiter }),
          ...(options.rateLimitConfig === undefined ? {} : { config: options.rateLimitConfig }),
        }),
        ...(options.imports ?? []),
      ],
      providers: [
        { provide: API_METRICS, useValue: metrics },
        // Global Zod validation (API-002): acts only on handler params bound to a Zod DTO.
        {
          provide: APP_PIPE,
          inject: [API_CONFIG, API_METRICS, API_LOGGER],
          useFactory: createValidationPipe,
        },
        { provide: API_SECURITY_EVENT_SINK, useFactory: () => options.securityEventSink },
        // Global problem+json filter: catches pipe/guard/handler errors and Fastify's own (API-004).
        { provide: APP_FILTER, useClass: ProblemJsonExceptionFilter },
      ],
      controllers: [SmokeController],
    };
  }
}
