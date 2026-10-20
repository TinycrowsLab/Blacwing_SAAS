import { type DynamicModule, Global, Module, type ModuleMetadata } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

import { createHttpMetrics, type HttpMetrics } from './bootstrap/metrics.js';
import { API_CONFIG, API_LOGGER, API_METRICS } from './bootstrap/tokens.js';
import { HealthModule } from './health/health.module.js';
import { SmokeController } from './smoke.controller.js';
import { createValidationPipe } from './validation/zod-validation.pipe.js';

import type { ApiConfig } from './config.js';
import type { HealthProbe } from './health/health.types.js';
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
      ],
      controllers: [SmokeController],
    };
  }
}
