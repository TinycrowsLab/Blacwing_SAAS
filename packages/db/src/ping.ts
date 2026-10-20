// `pnpm --filter @blackwing/db db:ping`: readiness of the app role against the configured database
// (the dev compose Postgres by default). Prints a JSON health line; exit 0 when healthy.

import { createLogger } from '@blackwing/logger';

import { createAppDatabase, verifyAppRole } from './client.js';
import { expandEnv } from './seed/env.js';

const logger = createLogger('@blackwing/db');
const database = createAppDatabase({ source: expandEnv(process.env), logger });
try {
  const health = await database.ping();
  if (health.ok) await verifyAppRole(database.pool);
  logger.info({ health }, 'db.ping');
  process.exitCode = health.ok ? 0 : 1;
} finally {
  await database.close();
}
