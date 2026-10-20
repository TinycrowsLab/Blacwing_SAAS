// The owner-role pool (DB-001, CONTEXT_PACK §7): migrations run as `bw_owner`, never as the runtime
// role. This entry point (`@blackwing/db/owner`) is kept out of the main one on purpose: runtime apps
// cannot reach it (dependency-cruiser rule `db-owner-only-from-migrate`), so they never load owner
// credentials. Only the migrate job (DB-002) and this package's tests import it.

import { createLogger } from '@blackwing/logger';

import { loadOwnerDbConfig, ownerDbEnvSchema } from './env.js';
import { createPool, type DbLogger, type DbPoolMetrics, type ObservedPool } from './pool.js';

import type { EnvSource } from '@blackwing/config';

export { loadOwnerDbConfig, ownerDbEnvSchema };

/** Options for {@link createOwnerPool}. */
export interface CreateOwnerPoolOptions {
  /** Environment to read (default `process.env`, through `@blackwing/config`). */
  readonly source?: EnvSource;
  readonly logger?: DbLogger;
  readonly metrics?: DbPoolMetrics;
}

/**
 * Creates the owner-role pool from `PG_OWNER_USER` / `PG_OWNER_PASSWORD`. Explicit factory only:
 * nothing creates it at import time. End it when the migration is done.
 */
export function createOwnerPool(options: CreateOwnerPoolOptions = {}): ObservedPool {
  const config = loadOwnerDbConfig(options.source);
  return createPool(config, 'owner', {
    logger: options.logger ?? createLogger('@blackwing/db'),
    applicationName: 'blackwing-migrate',
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
}
