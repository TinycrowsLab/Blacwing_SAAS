/** Workspace package name of this package. */
export const name = '@blackwing/memory';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// Surface-graph Neo4j driver (GRAPH-001, §5, §8.7).
export {
  graphEnvSchema,
  loadNeo4jConfig,
  type Neo4jConfig,
  NEO4J_URI_PROTOCOLS,
} from './graph/config.js';
export {
  checkGraphHealth,
  closeDriver,
  createGraphRuntime,
  createNeo4jDriver,
  type CreateNeo4jDriverOptions,
  type GraphHealth,
  type GraphLogger,
  type GraphMetrics,
  type GraphRuntime,
  getDriver,
  getGraph,
  withSession,
  withSessionOn,
} from './graph/driver.js';
// Forward-only migrations for the surface graph (GRAPH-002).
export {
  checkGraphMigrations,
  type GraphMigrationMetrics,
  type GraphMigrationOptions,
  type GraphMigrationReport,
  runGraphMigrations,
} from './graph/migrate.js';
// Tenant-guarded surface-graph repository (GRAPH-004, §8.6): the only sanctioned read and write path.
export {
  type EdgeUpsertResult,
  type EndpointPage,
  LIST_PAGE_MAX,
  type Neighbourhood,
  NEIGHBOUR_LIMIT,
  type NodePage,
  type RunSurface,
  type RunSurfaceEdge,
  type RunSurfaceNode,
  type RunSurfaceQuery,
  type RunSurfaceSummary,
  SurfaceGraphRepository,
  type SurfaceGraphMetrics,
  type SurfaceGraphOp,
  type SurfaceGraphOptions,
  type SurfaceUpsertAudit,
  type UpsertCounts,
  type UpsertResult,
  withTenantGraph,
  type WithTenantGraphOptions,
} from './graph/repository.js';
