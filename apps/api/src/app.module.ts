import { type DynamicModule, Global, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

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
import { SmokeController } from './smoke.controller.js';
import { createValidationPipe } from './validation/zod-validation.pipe.js';

import type { ApiConfig } from './config.js';
import type { HealthProbe } from './health/health.types.js';
import type { IdempotencyStore } from './idempotency/ports.js';
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
  /** Receives security-relevant errors (`permission_denied`, `tenant_context_missing`); AUDIT wires `emitAudit`. */
  readonly securityEventSink?: SecurityEventSink;
  /** Extra modules to mount (feature modules of later issues; test-only routes). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
}

/** Root module of the control-plane API. */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const metrics = options.metrics ?? createHttpMetrics();
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
