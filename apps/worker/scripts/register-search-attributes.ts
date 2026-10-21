// Registers the Blackwing custom search attributes in the configured Temporal namespace (WORKFLOW-003).
// Idempotent: safe on every deploy and on every `pnpm dev:deps`. Run with `pnpm --filter @blackwing/worker register:search-attributes`.
// Exits 0 when the attributes are present (created now or already there) and 1 on any failure, including a type conflict.
import { parseTemporalConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';
import { closeTemporal, getTemporalConnection } from '@blackwing/workflow-shared';

import { registerSearchAttributes } from '../src/search-attribute-registration.js';

const log = createLogger('worker').child({ component: 'search-attributes-script' });

async function main(): Promise<void> {
  const config = parseTemporalConfig();
  const connection = await getTemporalConnection({ config });
  const outcome = await registerSearchAttributes({
    operator: connection.operatorService,
    namespace: config.namespace,
  });
  log.info(
    { namespace: config.namespace, result: outcome.result },
    'search attribute registration complete',
  );
}

try {
  await main();
} catch (error) {
  log.error({ err: error }, 'search attribute registration failed');
  process.exitCode = 1;
} finally {
  await closeTemporal();
}
