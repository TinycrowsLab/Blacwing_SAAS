// Integration: the batched, provenance-aware upsert of surface nodes and edges (GRAPH-007) against a real Neo4j 5
// (`pnpm test:int`, Docker required). These cover the idempotency, multi-run retention, stub, atomicity and
// concurrency rules of the upsert, with the GRAPH-002 migrations applied, so the Run and Observation constraints run.
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { naturalKey, type SurfaceEdge, type SurfaceNode } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { type Neo4jHandle, withNeo4j } from '@blackwing/testing/containers';

import { createGraphRuntime, type GraphRuntime } from './driver.js';
import { runGraphMigrations } from './migrate.js';
import { type SurfaceUpsertAudit, withTenantGraph } from './repository.js';

import type { Neo4jConfig } from './config.js';
import type { AuditEventInput } from '@blackwing/audit';

// Each test owns a tenant, so the shared container never mixes their data.
const TENANT_ONE = '018f2a6e-1c00-7000-8000-0000000000e1';
const TENANT_TWO = '018f2a6e-1c00-7000-8000-0000000000e2';
const TENANT_THREE = '018f2a6e-1c00-7000-8000-0000000000e3';
const TENANT_FOUR = '018f2a6e-1c00-7000-8000-0000000000e4';
const RUN_A = '018f2a6e-1c01-7000-8000-00000000000a';
const RUN_B = '018f2a6e-1c01-7000-8000-00000000000b';
const RUN_C = '018f2a6e-1c01-7000-8000-00000000000c';
const EARLY = '2026-10-29T10:00:00.000Z';
const MIDDLE = '2026-10-29T10:05:00.000Z';
const LATE = '2026-10-29T10:10:00.000Z';

let neo: Neo4jHandle;
let runtime: GraphRuntime;
let driver: Driver;

function configFor(handle: Neo4jHandle, batch = 500): Neo4jConfig {
  return {
    uri: handle.boltUrl,
    username: handle.username,
    password: handle.password,
    database: 'neo4j',
    maxPoolSize: 10,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
    upsertBatchSize: batch,
  };
}

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function audit(): SurfaceUpsertAudit & { emitAudit: ReturnType<typeof vi.fn> } {
  return { emitAudit: vi.fn<(input: AuditEventInput) => Promise<void>>(() => Promise.resolve()) };
}

function endpoint(
  tenantId: string,
  runId: string,
  options: { confidence?: number; lastSeenAt?: string; firstSeenAt?: string } = {},
): SurfaceNode {
  return {
    kind: 'endpoint',
    tenantId,
    provenance: {
      runId,
      tool: 'crawler',
      persona: 'recon',
      confidence: options.confidence ?? 0.5,
      firstSeenAt: options.firstSeenAt ?? EARLY,
      lastSeenAt: options.lastSeenAt ?? MIDDLE,
    },
    assetId: '018f2a6e-1c02-7000-8000-000000000042',
    method: 'GET',
    pathTemplate: '/users/{id}',
    contentTypes: [],
    authRequired: true,
  };
}

function host(tenantId: string, hostname: string, runId = RUN_A): SurfaceNode {
  return {
    kind: 'host',
    tenantId,
    provenance: { runId, confidence: 0.8, firstSeenAt: EARLY, lastSeenAt: MIDDLE },
    hostname,
    inScope: true,
  };
}

/** Runs a read-only count query against the graph and returns it as a plain number. */
async function scalar(cypher: string, params: Record<string, unknown>): Promise<number> {
  const result = await driver.executeQuery(cypher, params, { database: runtime.database });
  const value: unknown = result.records[0]?.get('value');
  return neo4j.isInt(value) ? value.toNumber() : Number(value);
}

/** The stored properties of the node of a natural key (any label), or undefined. */
async function storedNode(
  tenantId: string,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await driver.executeQuery(
    'MATCH (n {tenantId: $tenantId, naturalKey: $key}) RETURN properties(n) AS props LIMIT 1',
    { tenantId, key },
    { database: runtime.database },
  );
  const props: unknown = result.records[0]?.get('props');
  return props === undefined ? undefined : (props as Record<string, unknown>);
}

beforeAll(async () => {
  neo = await withNeo4j();
  runtime = createGraphRuntime(configFor(neo), { logger: quietLogger });
  driver = runtime.driver;
  await runGraphMigrations(runtime);
}, 180_000);

afterAll(async () => {
  await runtime.driver.close();
  await neo.stop();
});

describe('surface upsert against Neo4j 5 (GRAPH-007)', () => {
  it('writes one node for a repeated upsert: the second call creates nothing and updates it', async () => {
    const sink = audit();
    const node = host(TENANT_ONE, 'api.one.test');
    const first = await withTenantGraph(TENANT_ONE, (repo) => repo.upsertNodes([node]), {
      runtime,
      audit: sink,
    });
    const second = await withTenantGraph(TENANT_ONE, (repo) => repo.upsertNodes([node]), {
      runtime,
      audit: sink,
    });
    expect(first).toMatchObject({ created: 1, updated: 0 });
    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(
      await scalar('MATCH (n:Host {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_ONE,
      }),
    ).toBe(1);
  });

  it('keeps one endpoint seen in two runs with two OBSERVED_IN runs, max confidence and the later lastSeenAt', async () => {
    const sink = audit();
    const key = naturalKey(endpoint(TENANT_TWO, RUN_A));
    await withTenantGraph(
      TENANT_TWO,
      (repo) =>
        repo.upsertNodes([endpoint(TENANT_TWO, RUN_A, { confidence: 0.9, lastSeenAt: MIDDLE })]),
      { runtime, audit: sink },
    );
    await withTenantGraph(
      TENANT_TWO,
      (repo) =>
        repo.upsertNodes([
          endpoint(TENANT_TWO, RUN_B, { confidence: 0.4, lastSeenAt: LATE, firstSeenAt: LATE }),
        ]),
      { runtime, audit: sink },
    );

    expect(
      await scalar(
        'MATCH (n:Endpoint {tenantId: $tenantId, naturalKey: $key})-[:OBSERVED_IN]->(r:Run) RETURN count(r) AS value',
        { tenantId: TENANT_TWO, key },
      ),
    ).toBe(2);
    const stored = await storedNode(TENANT_TWO, key);
    expect(stored).toMatchObject({
      provenance_confidence: 0.9,
      provenance_lastSeenAt: LATE,
      provenance_firstSeenAt: EARLY,
      provenance_runId: RUN_B,
    });
    expect(
      await scalar('MATCH (n:Endpoint {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_TWO,
      }),
    ).toBe(1);
  });

  it('keeps one observation per (run, natural key, tool): replaying the batch adds none', async () => {
    const sink = audit();
    const batch = [endpoint(TENANT_THREE, RUN_A)];
    await withTenantGraph(TENANT_THREE, (repo) => repo.upsertNodes(batch), {
      runtime,
      audit: sink,
    });
    const replay = await withTenantGraph(TENANT_THREE, (repo) => repo.upsertNodes(batch), {
      runtime,
      audit: sink,
    });
    expect(replay).toMatchObject({ created: 0, updated: 1 });
    expect(
      await scalar('MATCH (o:Observation {tenantId: $tenantId}) RETURN count(o) AS value', {
        tenantId: TENANT_THREE,
      }),
    ).toBe(1);
  });

  it('creates a stub for an absent endpoint instead of failing, hides it from reads, and upgrades it on observation', async () => {
    const sink = audit();
    const from = host(TENANT_FOUR, 'stub.four.test');
    const edge: SurfaceEdge = {
      kind: 'EXPOSES',
      tenantId: TENANT_FOUR,
      provenance: { runId: RUN_C, confidence: 0.7, firstSeenAt: EARLY, lastSeenAt: MIDDLE },
      fromKey: naturalKey(from),
      toKey: `service:${TENANT_FOUR}:stub.four.test:443:tcp`,
    };
    const result = await withTenantGraph(TENANT_FOUR, (repo) => repo.upsertEdges([edge]), {
      runtime,
      audit: sink,
    });
    expect(result).toMatchObject({ created: 1, stubs: 2 });

    const stub = await storedNode(TENANT_FOUR, naturalKey(from));
    expect(stub).toMatchObject({ stub: true, provenance_confidence: 0 });
    // A stub has no contract fields, so the typed reads never see it.
    await withTenantGraph(
      TENANT_FOUR,
      async (repo) => {
        expect(await repo.getNode('host', naturalKey(from))).toBeUndefined();
        expect(await repo.countByTenant('host')).toBe(0);
      },
      { runtime, audit: sink },
    );

    // Observing the real host upgrades the stub: the flag is cleared and it becomes readable.
    const observed = await withTenantGraph(TENANT_FOUR, (repo) => repo.upsertNodes([from]), {
      runtime,
      audit: sink,
    });
    expect(observed).toMatchObject({ created: 0, updated: 1 });
    await withTenantGraph(
      TENANT_FOUR,
      async (repo) => {
        const readBack = await repo.getNode('host', naturalKey(from));
        expect(readBack).toMatchObject({ kind: 'host', hostname: 'stub.four.test', inScope: true });
      },
      { runtime, audit: sink },
    );
    // Setting the flag to null removes the property, so a real node carries no stub marker at all.
    expect((await storedNode(TENANT_FOUR, naturalKey(from)))?.stub).toBeUndefined();
  });

  it('refuses a batch that holds a foreign-tenant node and writes none of its rows', async () => {
    const sink = audit();
    const error: unknown = await withTenantGraph(
      TENANT_ONE,
      (repo) =>
        repo.upsertNodes([
          host(TENANT_ONE, 'atomic.one.test'),
          host(TENANT_TWO, 'atomic.two.test'),
        ]),
      { runtime, audit: sink },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_TENANT_MISMATCH');
    expect(
      await scalar(
        "MATCH (n:Host {tenantId: $tenantId, naturalKey: 'host:" +
          TENANT_ONE +
          ":atomic.one.test'}) RETURN count(n) AS value",
        { tenantId: TENANT_ONE },
      ),
    ).toBe(0);
    expect(sink.emitAudit).not.toHaveBeenCalled();
  });

  it('converges under concurrent upserts of one endpoint from two runs, whatever the order', async () => {
    const sink = audit();
    const tenant = '018f2a6e-1c00-7000-8000-0000000000e5';
    const early = endpoint(tenant, RUN_A, { confidence: 0.3, lastSeenAt: MIDDLE });
    const late = endpoint(tenant, RUN_B, { confidence: 0.8, lastSeenAt: LATE });
    await Promise.all([
      withTenantGraph(tenant, (repo) => repo.upsertNodes([early]), { runtime, audit: sink }),
      withTenantGraph(tenant, (repo) => repo.upsertNodes([late]), { runtime, audit: sink }),
    ]);
    const stored = await storedNode(tenant, naturalKey(early));
    expect(stored).toMatchObject({
      provenance_confidence: 0.8,
      provenance_lastSeenAt: LATE,
      provenance_runId: RUN_B,
    });
    expect(
      await scalar('MATCH (n:Endpoint {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: tenant,
      }),
    ).toBe(1);
  });

  it('splits a large batch into chunks of the configured size and reports the totals', async () => {
    const tenant = '018f2a6e-1c00-7000-8000-0000000000e6';
    const chunked = createGraphRuntime(configFor(neo, 2), { logger: quietLogger });
    const sink = audit();
    const hosts = ['c1', 'c2', 'c3', 'c4', 'c5'].map((name) => host(tenant, `${name}.chunk.test`));
    try {
      const result = await withTenantGraph(tenant, (repo) => repo.upsertNodes(hosts), {
        runtime: chunked,
        audit: sink,
      });
      expect(result).toMatchObject({ created: 5, updated: 0 });
      expect(result.byKind.host).toEqual({ created: 5, updated: 0 });
      expect(sink.emitAudit).toHaveBeenCalledTimes(1);
    } finally {
      await chunked.driver.close();
    }
  });
});
