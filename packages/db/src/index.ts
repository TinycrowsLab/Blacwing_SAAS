/** Workspace package name of this package. */
export const name = '@blackwing/db';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// Runtime entry point: the app-role pool only. The owner pool is `@blackwing/db/owner` (DB-001).
export {
  appDatabase,
  type AppDatabase,
  closeDb,
  createAppDatabase,
  type CreateAppDatabaseOptions,
  createDatabase,
  type Database,
  DEFAULT_PING_TIMEOUT_MS,
  type DbHealth,
  getDb,
  pingDb,
  pingPool,
  type Tx,
  UnsafeDbRoleError,
  verifyAppRole,
} from './client.js';
export {
  appDbEnvSchema,
  DB_ROLES,
  type DbConnectionConfig,
  DEFAULT_PG_ACQUIRE_TIMEOUT_MS,
  DEFAULT_PG_DATABASE,
  DEFAULT_PG_IDLE_TIMEOUT_MS,
  DEFAULT_PG_POOL_MAX,
  DEFAULT_PG_PORT,
  loadAppDbConfig,
  PG_SSL_MODES,
  type PgSslMode,
} from './env.js';
export {
  migrateDatabase,
  type MigrationLogger,
  migrationNames,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
} from './migrate.js';
export {
  type DbLogger,
  type DbPoolMetrics,
  DbUnavailableError,
  type DbUnavailableReason,
  ObservedPool,
  type PoolName,
} from './pool.js';
export * from './schema/index.js';
