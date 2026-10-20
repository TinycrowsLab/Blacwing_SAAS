import { CONFIG_EXIT_CODE, type EnvSource, isConfigValidationError } from '@blackwing/config';
import { createLogger, type Logger } from '@blackwing/logger';

import { loggerAuditSink, type GatewayAuditSink } from './audit.js';
import { staticVirtualKeyVerifier } from './auth.js';
import { type GatewayConfig, loadGatewayConfig } from './config.js';
import { DevSubscriptionAdapter } from './dev-subscription/adapter.js';
import { announceDevSubscription } from './dev-subscription/banner.js';
import { ClaudeCodeLoginStore } from './dev-subscription/credentials.js';
import {
  assertDevSubscriptionAllowed,
  DEV_SUBSCRIPTION_PROVIDER_ID,
  devSubscriptionRequested,
  DevSubscriptionRefusedError,
} from './dev-subscription/guard.js';
import { createGatewayMetrics, type GatewayMetrics } from './metrics.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { staticApiKeyResolver } from './providers/credentials.js';
import { buildGateway } from './server.js';

import type { Tracer } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';

export interface BootDependencies {
  readonly logger: Logger;
  readonly audit?: GatewayAuditSink;
  /** Plain-text sink for the dev provider banner. */
  readonly write: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly tracer?: Tracer;
  readonly metrics?: GatewayMetrics;
}

export interface BootedGateway {
  readonly app: FastifyInstance;
  /** Stops background timers (the recurring dev banner). */
  readonly stop: () => void;
}

/**
 * Builds the gateway for a loaded configuration. Throws {@link DevSubscriptionRefusedError} when the dev
 * subscription provider is configured anywhere but `BW_ENV=dev` with its explicit flag, or without the
 * virtual key and dev tenant it needs: the process must not start in that state.
 */
export function bootGateway(
  config: Readonly<GatewayConfig>,
  deps: BootDependencies,
): BootedGateway {
  const audit = deps.audit ?? loggerAuditSink(deps.logger);
  const metrics = deps.metrics ?? createGatewayMetrics();
  const observability = {
    metrics,
    ...(deps.tracer === undefined ? {} : { tracer: deps.tracer }),
  };
  if (!devSubscriptionRequested(config)) {
    const adapter = new AnthropicAdapter({
      baseUrl: config.GATEWAY_ANTHROPIC_BASE_URL,
      resolveCredential: staticApiKeyResolver(config.GATEWAY_ANTHROPIC_API_KEY),
      logger: deps.logger,
      ...observability,
      audit: (event) => {
        deps.logger.info(event, 'audit.provider.call');
      },
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
    const app = buildGateway({ config, adapter, logger: deps.logger, audit, ...observability });
    return { app, stop: () => undefined };
  }

  assertDevSubscriptionAllowed(config);
  if (config.GATEWAY_DEFAULT_PROVIDER !== DEV_SUBSCRIPTION_PROVIDER_ID) {
    throw new DevSubscriptionRefusedError(
      'GATEWAY_DEV_SUBSCRIPTION_ENABLED=true requires GATEWAY_DEFAULT_PROVIDER=dev_subscription.',
    );
  }
  const tenantIds = config.GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS ?? [];
  const firstTenant = tenantIds[0];
  const keySha256Hex = config.GATEWAY_DEV_VIRTUAL_KEY_SHA256;
  if (firstTenant === undefined || keySha256Hex === undefined) {
    throw new DevSubscriptionRefusedError(
      'The dev_subscription provider requires GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS and GATEWAY_DEV_VIRTUAL_KEY_SHA256.',
    );
  }
  const adapter = new DevSubscriptionAdapter({
    baseUrl: config.GATEWAY_ANTHROPIC_BASE_URL,
    credentials: new ClaudeCodeLoginStore({
      path: config.GATEWAY_DEV_SUBSCRIPTION_CREDENTIALS_FILE,
    }),
    allowedTenantIds: tenantIds,
    environment: () => config,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  // GATEWAY-002 (#405) replaces this single dev key with per-session virtual keys.
  const verifier = staticVirtualKeyVerifier({ keySha256Hex, tenantId: firstTenant });
  const app = buildGateway({
    config,
    adapter,
    logger: deps.logger,
    audit,
    verifier,
    ...observability,
  });
  const stop = announceDevSubscription({
    logger: deps.logger,
    audit,
    intervalMs: config.GATEWAY_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS,
    write: deps.write,
  });
  return { app, stop };
}

export interface RunOptions {
  /** Environment to load; defaults to the process environment. */
  readonly source?: EnvSource;
  readonly exit: (code: number) => void;
  readonly write: (text: string) => void;
  /** Overrides the logger built from config (tests). */
  readonly logger?: Logger;
}

/**
 * Process entry: load config, boot, listen, drain on SIGTERM/SIGINT. A refused or invalid configuration
 * exits with `CONFIG_EXIT_CODE` before anything listens. Returns the app when it is listening.
 */
export async function runGateway(options: RunOptions): Promise<FastifyInstance | undefined> {
  let config: Readonly<GatewayConfig>;
  try {
    config = loadGatewayConfig(options.source);
  } catch (error) {
    if (!isConfigValidationError(error)) throw error;
    options.write(`model-gateway: invalid configuration: ${error.message}\n`);
    options.exit(CONFIG_EXIT_CODE);
    return undefined;
  }
  const logger =
    options.logger ??
    createLogger('model-gateway', { level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });

  let booted: BootedGateway;
  try {
    booted = bootGateway(config, { logger, write: options.write });
  } catch (error) {
    if (!(error instanceof DevSubscriptionRefusedError)) throw error;
    logger.fatal({ code: error.code, reason: error.message }, 'gw.boot_refused');
    options.exit(CONFIG_EXIT_CODE);
    return undefined;
  }
  const { app, stop } = booted;

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'gw.shutdown');
    stop();
    app.close().then(
      () => {
        options.exit(0);
      },
      () => {
        options.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
  logger.info(
    { port: config.GATEWAY_PORT, provider: config.GATEWAY_DEFAULT_PROVIDER },
    'gw.listening',
  );
  return app;
}
