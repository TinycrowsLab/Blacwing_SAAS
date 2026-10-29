import { CONFIG_EXIT_CODE, type EnvSource, isConfigValidationError } from '@blackwing/config';
import { serializeErrorForLog } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { authOptionsFromConfig } from './auth/from-config.js';
import { createApiApp, type CreateApiAppOptions } from './bootstrap/create-app.js';
import { createHttpMetrics } from './bootstrap/metrics.js';
import { type ApiConfig, loadApiConfig } from './config.js';
import { demoModuleFor } from './demo/index.js';

import type { AuthOptions } from './auth/module.js';
import type { SessionValkey } from './auth/session-cookie.js';
import type { TenantPrincipalSource } from './tenant/guard.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Registry } from 'prom-client';

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
  /**
   * Credential validators of the global auth guard (#335). Defaults to the validators built from
   * configuration: a path whose settings are absent refuses its credentials (fail closed).
   */
  readonly auth?: AuthOptions;
  /**
   * Read access to the BFF's Valkey, used to open session cookies. Absent, BFF session cookies are refused.
   */
  readonly sessionValkey?: SessionValkey;
  /**
   * IAM's validated-principal lookup, an alternative to `auth` for tests. Mutually exclusive with `auth`.
   */
  readonly tenantPrincipalSource?: TenantPrincipalSource;
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

  const metrics = createHttpMetrics();
  try {
    const auth =
      options.auth ??
      (options.tenantPrincipalSource === undefined
        ? authFromConfig(config, logger, metrics.registry, options.sessionValkey)
        : undefined);
    const { app } = await createApiApp({
      config,
      logger,
      metrics,
      shutdownHooks: true,
      ...(auth === undefined ? {} : { auth }),
      ...(options.tenantPrincipalSource === undefined
        ? {}
        : { tenantPrincipalSource: options.tenantPrincipalSource }),
      // DEMO-STORY: the demo module is mounted only when BW_DEMO_MODE=1 (inert otherwise).
      imports: [...(options.imports ?? []), ...demoModuleFor(options.source)],
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

function authFromConfig(
  config: Readonly<ApiConfig>,
  logger: Logger,
  registry: Registry,
  sessionValkey: SessionValkey | undefined,
): AuthOptions {
  if (config.BW_WEB_SESSION_SECRET !== undefined && sessionValkey === undefined) {
    // The session path needs the BFF's Valkey, which this entry point does not connect: cookies stay refused.
    logger.warn({ event: 'auth.session_store_not_configured' }, 'BFF session cookies are refused');
  }
  return authOptionsFromConfig({
    config,
    logger,
    registry,
    ...(sessionValkey === undefined ? {} : { sessionValkey }),
  });
}
