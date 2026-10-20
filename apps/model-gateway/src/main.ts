import { defineConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { gatewayEnvSchema } from './config.js';
import { AnthropicStubAdapter, staticAnthropicCredentials } from './provider.js';
import { buildGateway } from './server.js';

/** Process entry point: load config (fail fast), build the gateway, listen, drain on SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const config = defineConfig(gatewayEnvSchema);
  const logger = createLogger('model-gateway', {
    level: config.LOG_LEVEL,
    nodeEnv: config.NODE_ENV,
  });
  const adapter = new AnthropicStubAdapter({
    baseUrl: config.GATEWAY_ANTHROPIC_BASE_URL,
    credentials: staticAnthropicCredentials(config.GATEWAY_ANTHROPIC_API_KEY),
  });
  const app = buildGateway({ config, adapter, logger });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'gw.shutdown');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT });
  logger.info(
    { port: config.GATEWAY_PORT, provider: config.GATEWAY_DEFAULT_PROVIDER },
    'gw.listening',
  );
}

await main();
