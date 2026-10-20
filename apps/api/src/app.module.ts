import { type DynamicModule, Global, Module, type ModuleMetadata } from '@nestjs/common';

import { API_CONFIG, API_LOGGER } from './bootstrap/tokens.js';
import { SmokeController } from './smoke.controller.js';

import type { ApiConfig } from './config.js';
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
  /** Extra modules to mount (feature modules of later issues; test-only routes). */
  readonly imports?: NonNullable<ModuleMetadata['imports']>;
}

/** Root module of the control-plane API. */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(options.config),
        LoggerModule.forRoot(options.logger),
        ...(options.imports ?? []),
      ],
      controllers: [SmokeController],
    };
  }
}
