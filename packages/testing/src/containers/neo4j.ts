import neo4j, { type Driver, type QueryResult, type RecordShape } from 'neo4j-driver';
import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
} from './runtime.js';
import { TenantContextError, tenantUuid } from './tenant.js';

const BOLT_PORT = 7687;
const USERNAME = 'neo4j';
const TENANT_PARAMETER = /\$tenantId\b/;

/** Options for {@link withNeo4j}. */
export type WithNeo4jOptions = ContainerOptions;

/** A Neo4j 5 Community server and a driver. */
export interface Neo4jHandle {
  readonly service: 'neo4j';
  readonly boltUrl: string;
  readonly username: string;
  readonly password: string;
  readonly driver: Driver;
  readonly reused: boolean;
  /** Docker id of the container (for debugging and leak checks). */
  readonly containerId: string;
  /**
   * Runs `cypher` for one tenant through the test-side tenantId guard (see {@link runForTenant}),
   * and remembers the tenant so `stop` can remove its nodes from a reused server.
   */
  runForTenant<R extends RecordShape = RecordShape>(
    tenantId: string,
    cypher: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<QueryResult<R>>;
  logs(): string;
  /** Removes the nodes of every tenant used through this handle (reused servers), closes the driver, stops the container. */
  stop(): Promise<void>;
}

/**
 * The §8.6 Neo4j tenantId guard pattern, for tests: a query runs only if it filters on `$tenantId`,
 * the caller cannot supply `tenantId` itself, and the id is a valid tenant id. Anything else throws
 * {@link TenantContextError} before the query reaches the server (fail closed).
 *
 * The production guard belongs to the graph repository layer (#436); this helper lets tests seed and
 * read tenant-scoped graph data the same way.
 */
export async function runForTenant<R extends RecordShape = RecordShape>(
  driver: Driver,
  tenantId: string,
  cypher: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<QueryResult<R>> {
  const tenant = tenantUuid(tenantId);
  if (!TENANT_PARAMETER.test(cypher)) {
    throw new TenantContextError(
      'graph queries must filter on $tenantId: refusing an unscoped query',
    );
  }
  if (Object.hasOwn(params, 'tenantId')) {
    throw new TenantContextError(
      'tenantId is bound by the guard and cannot be passed as a parameter',
    );
  }
  return driver.executeQuery<QueryResult<R>>(cypher, { ...params, tenantId: tenant });
}

/** Starts Neo4j 5 Community (pinned by digest) with authentication and a small heap. */
export async function withNeo4j(options: WithNeo4jOptions = {}): Promise<Neo4jHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.neo4j);
  const password = containerCredential('neo4j:password', reuse);
  const started = await startContainer({
    service: 'neo4j',
    image,
    ports: [BOLT_PORT],
    env: {
      NEO4J_AUTH: `${USERNAME}/${password}`,
      NEO4J_server_memory_heap_initial__size: '256m',
      NEO4J_server_memory_heap_max__size: '512m',
      NEO4J_server_memory_pagecache_size: '128m',
      NEO4J_dbms_usage__report_enabled: 'false',
    },
    wait: Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/Started\./)]),
    reuse,
    startupTimeoutMs,
  });
  const boltUrl = `bolt://${started.container.getHost()}:${started.container.getMappedPort(BOLT_PORT)}`;
  const driver = neo4j.driver(boltUrl, neo4j.auth.basic(USERNAME, password), {
    disableLosslessIntegers: true,
  });
  const tenants = new Set<string>();
  let stopped = false;

  try {
    await driver.verifyConnectivity();
  } catch (error) {
    await driver.close().catch(() => undefined);
    await started.stop().catch(() => undefined);
    throw error;
  }

  return {
    service: 'neo4j',
    boltUrl,
    username: USERNAME,
    password,
    driver,
    reused: started.reused,
    containerId: started.containerId,
    runForTenant: async <R extends RecordShape = RecordShape>(
      tenantId: string,
      cypher: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<QueryResult<R>> => {
      const result = await runForTenant<R>(driver, tenantId, cypher, params);
      tenants.add(tenantUuid(tenantId));
      return result;
    },
    logs: () => started.logs(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        if (started.reused && tenants.size > 0) {
          await driver.executeQuery('MATCH (n) WHERE n.tenantId IN $tenants DETACH DELETE n', {
            tenants: [...tenants],
          });
        }
      } finally {
        await driver.close().catch(() => undefined);
        await started.stop();
      }
    },
  };
}
