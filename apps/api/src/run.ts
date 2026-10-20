import { CONFIG_EXIT_CODE, type EnvSource, isConfigValidationError } from '@blackwing/config';
import { serializeErrorForLog } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { createApiApp, type CreateApiAppOptions } from './bootstrap/create-app.js';
import { type ApiConfig, loadApiConfig } from './config.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Exit status of a process whose boot failed after its configuration was accepted. */
export const BOOT_FAILURE_EXIT_CODE = 1;

export interface RunApiOptions {
  /** Environment to load; defaults to the process environment. */
  readonly source?: EnvSource;
  readonly exit: (code: number) => void;
  /** Plain-text sink (stderr) for the refusal message when there is no valid config to build a logger. */
  readonly write: (text: string) => void;
  /** Overrides the logger built from config (tests). */
  readonly logger?: Logger;
  /** Extra modules to mount (see `CreateApiAppOptions.imports`). */
  readonly imports?: CreateApiAppOptions['imports'];
}

/**
 * Process entry: load and validate config (fail closed), build the app, listen, and drain on
 * SIGTERM/SIGINT. Invalid configuration exits with `CONFIG_EXIT_CODE` before anything is built.
 */
export async function runApi(options: RunApiOptions): Promise<NestFastifyApplication | undefined> {
  let config: Readonly<ApiConfig>;
  try {
    config = loadApiConfig(options.source);
  } catch (error) {
    if (!isConfigValidationError(error)) throw error;
    // The message names keys only, never values (see @blackwing/config).
    options.write(`api: refusing to start: ${error.code}: ${error.message}\n`);
    (options.logger ?? createLogger('api')).fatal(
      { code: error.code, missingKeys: error.missingKeys, invalidKeys: error.invalidKeys },
      'api.config_invalid',
    );
    options.exit(CONFIG_EXIT_CODE);
    return undefined;
  }
  const logger =
    options.logger ?? createLogger('api', { level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });

  try {
    const { app } = await createApiApp({
      config,
      logger,
      shutdownHooks: true,
      ...(options.imports === undefined ? {} : { imports: options.imports }),
    });
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
    logger.info({ port: config.API_PORT, host: config.API_HOST }, 'api.listening');
    return app;
  } catch (error) {
    logger.fatal({ err: serializeErrorForLog(error) }, 'api.boot_failed');
    options.exit(BOOT_FAILURE_EXIT_CODE);
    return undefined;
  }
}
