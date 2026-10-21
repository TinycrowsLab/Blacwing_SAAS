// Testcontainers helpers (CONTEXT_PACK §5: Testcontainers for integration tests; §8.6 tenant isolation).
// Import from *.int.test.ts files only: these helpers need a container runtime.

export { readTestEnv, resolveReuse, type TestEnv } from './env.js';
export { isDigestPinned, TEST_IMAGES, type TestImageName } from './images.js';
export { type MinioHandle, withMinio, type WithMinioOptions } from './minio.js';
export { type Neo4jHandle, runForTenant, withNeo4j, type WithNeo4jOptions } from './neo4j.js';
export {
  MigrationError,
  type MigrationRunner,
  type PostgresHandle,
  RLS_ROLES,
  RLS_SQL_FILES,
  withPostgres,
  type WithPostgresOptions,
} from './postgres.js';
export { type OpenBaoHandle, withOpenBao, type WithOpenBaoOptions } from './openbao.js';
export {
  CONTAINER_LABEL,
  type ContainerOptions,
  ContainerStartError,
  DEFAULT_STARTUP_TIMEOUT_MS,
  type DockerProbe,
  DockerUnavailableError,
  ensureDockerAvailable,
  isDockerAvailable,
  UnsafeTestEnvironmentError,
} from './runtime.js';
export {
  expectAllTenantTablesForceRls,
  expectAppRoleCannotBypass,
  expectEveryTenantTableCovered,
  expectFailsClosedWithoutContext,
  expectNoLeakAcrossTransactions,
  expectRlsBlocksCrossTenant,
  type CrossTenantOptions,
  listTenantTables,
  TenantIsolationError,
} from './tenant-isolation.js';
export { type Queryable, TenantContextError, tenantUuid, withTenant } from './tenant.js';
export { type TemporalHandle, withTemporal, type WithTemporalOptions } from './temporal.js';
export { type ValkeyHandle, withValkey, type WithValkeyOptions } from './valkey.js';
