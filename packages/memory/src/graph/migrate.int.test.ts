// Integration: needs Docker for Testcontainers Neo4j 5 (`pnpm test:int`). Not run on machines without Docker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { withNeo4j, type Neo4jHandle } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { createGraphRuntime, type GraphRuntime } from './driver.js';
import {
  checkGraphMigrations,
  loadGraphMigrations,
  type GraphMigration,
  neo4jMigrationStore,
  runGraphMigrations,
  isGraphMigrationReportClean,
} from './migrate.js';

import type { Neo4jConfig } from './config.js';

let neo: Neo4jHandle | undefined;
let runtime: GraphRuntime | undefined;

const graph = (): GraphRuntime => {
  if (runtime === undefined) throw new Error('graph runtime did not start');
  return runtime;
};

const handle = (): Neo4jHandle => {
  if (neo === undefined) throw new Error('withNeo4j did not start');
  return neo;
};

function configFor(target: Neo4jHandle): Neo4jConfig {
  return {
    uri: target.boltUrl,
    username: target.username,
    password: target.password,
    database: 'neo4j',
    maxPoolSize: 10,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
    upsertBatchSize: 500,
  };
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function namesOf(query: string): Promise<string[]> {
  const { records } = await handle().driver.executeQuery(query);
  return records.map((record) => String(record.get('name')));
}

beforeAll(async () => {
  neo = await withNeo4j();
  runtime = createGraphRuntime(configFor(handle()), { logger: silentLogger });
}, 180_000);

afterAll(async () => {
  await runtime?.driver.close();
  await neo?.stop();
});

surfaceContainerLogsOnFailure(() => [neo]);

// The steps share one database (Neo4j Community has a single one), so they run in order.
describe('surface graph migrations against Neo4j 5', () => {
  it('reports every migration pending before the first run, without creating anything', async () => {
    const report = await checkGraphMigrations(graph());
    expect(report.pending).toEqual([
      '0001_surface_constraints',
      '0002_run_observation_constraints',
    ]);
    expect(isGraphMigrationReportClean(report)).toBe(false);
    expect(await namesOf('SHOW CONSTRAINTS YIELD name RETURN name')).not.toContain('asset_key');
  });

  it('creates every surface constraint and index on a fresh database', async () => {
    const applied = await runGraphMigrations(graph());
    expect(applied).toEqual(['0001_surface_constraints', '0002_run_observation_constraints']);

    const constraints = await namesOf('SHOW CONSTRAINTS YIELD name RETURN name');
    for (const name of [
      'asset_key',
      'host_key',
      'service_key',
      'technology_key',
      'endpoint_key',
      'parameter_key',
      'role_key',
    ]) {
      expect(constraints).toContain(name);
    }
    const indexes = await namesOf('SHOW INDEXES YIELD name RETURN name');
    for (const name of [
      'asset_tenant_idx',
      'role_tenant_idx',
      'endpoint_asset_idx',
      'service_port_idx',
      'technology_name_idx',
    ]) {
      expect(indexes).toContain(name);
    }
  });

  it('records the applied migration in the ledger with its checksum and statement count', async () => {
    const [first, second] = loadGraphMigrations();
    const ledger = await neo4jMigrationStore(graph()).readLedger();
    expect(ledger).toEqual([
      {
        id: '0001_surface_constraints',
        checksum: first?.checksum,
        status: 'applied',
        statementsApplied: first?.statements.length,
      },
      {
        id: '0002_run_observation_constraints',
        checksum: second?.checksum,
        status: 'applied',
        statementsApplied: second?.statements.length,
      },
    ]);
  });

  it('is a no-op on a second run and reports clean afterwards', async () => {
    expect(await runGraphMigrations(graph())).toEqual([]);
    const report = await checkGraphMigrations(graph());
    expect(isGraphMigrationReportClean(report)).toBe(true);
    expect(report.applied).toEqual([
      '0001_surface_constraints',
      '0002_run_observation_constraints',
    ]);
  });

  it('throws GRAPH_MIGRATION_DRIFT when an applied migration no longer matches its checksum', async () => {
    const [migration] = loadGraphMigrations();
    const tampered: GraphMigration = {
      id: '0001_surface_constraints',
      checksum: 'f'.repeat(64),
      statements: migration?.statements ?? [],
    };
    const error = await runGraphMigrations(graph(), { migrations: [tampered] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_MIGRATION_DRIFT');
  });

  it('enforces uniqueness per tenant: same assetId under another tenant succeeds, same tenant fails', async () => {
    const write = (tenantId: string, assetId: string) =>
      handle().driver.executeQuery('CREATE (:Asset {tenantId: $tenantId, assetId: $assetId})', {
        tenantId,
        assetId,
      });
    await write('tenant-a', 'asset-1');
    await write('tenant-b', 'asset-1');
    await expect(write('tenant-a', 'asset-1')).rejects.toThrow(
      /already exists|ConstraintValidation/i,
    );
  });

  it('allows only one concurrent lock holder and lets the holder release it', async () => {
    const store = neo4jMigrationStore(graph());
    const now = Date.now();
    const results = await Promise.all([
      store.acquireLock('pod-a', now, 60_000),
      store.acquireLock('pod-b', now, 60_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? 'pod-a' : 'pod-b';
    const loser = winner === 'pod-a' ? 'pod-b' : 'pod-a';
    expect(await store.acquireLock(loser, now, 60_000)).toBe(false);
    await store.releaseLock(winner);
    expect(await store.acquireLock(loser, now, 60_000)).toBe(true);
    await store.releaseLock(loser);
  });

  it('takes over a lock whose lease has ended', async () => {
    const store = neo4jMigrationStore(graph());
    const now = Date.now();
    expect(await store.acquireLock('dead-pod', now, 1)).toBe(true);
    expect(await store.acquireLock('live-pod', now + 10_000, 60_000)).toBe(true);
    await store.releaseLock('live-pod');
  });
});
