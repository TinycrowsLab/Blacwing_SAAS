// Integration: the run-surface read (GRAPH-006) against a real Neo4j 5 (`pnpm test:int`, Docker required). Proves the
// server-side ranking and caps, keyset paging, the no-dangling-edge rule and the cross-tenant isolation of the read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { naturalKey, type SurfaceEdge, type SurfaceNode } from '@blackwing/contracts';
import { type Neo4jHandle, withNeo4j } from '@blackwing/testing/containers';

import { createGraphRuntime, type GraphRuntime } from './driver.js';
import { withTenantGraph } from './repository.js';

import type { Neo4jConfig } from './config.js';

const TENANT_A = '018f2a6e-1c00-7000-8000-00000000000a';
const TENANT_B = '018f2a6e-1c00-7000-8000-00000000000b';
const RUN_ID = '018f2a6e-1c01-7000-8000-000000000001';
const OTHER_RUN_ID = '018f2a6e-1c01-7000-8000-000000000002';
const QUERY: { minConfidence: number; limit: number; nodeCap: number; edgeCap: number } = {
  minConfidence: 0,
  limit: 50,
  nodeCap: 2000,
  edgeCap: 4000,
};

let neo: Neo4jHandle;
let runtime: GraphRuntime;

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function provenance(runId: string, confidence = 0.8) {
  return {
    runId,
    confidence,
    firstSeenAt: '2026-10-29T10:00:00.000Z',
    lastSeenAt: '2026-10-29T10:05:00.000Z',
  };
}

function host(tenantId: string, hostname: string, runId = RUN_ID, confidence = 0.8): SurfaceNode {
  return {
    kind: 'host',
    tenantId,
    provenance: provenance(runId, confidence),
    hostname,
    inScope: true,
  };
}

function service(tenantId: string, hostname: string, port: number): SurfaceNode {
  return {
    kind: 'service',
    tenantId,
    provenance: provenance(RUN_ID),
    hostname,
    port,
    protocol: 'tcp',
  };
}

function exposes(tenantId: string, from: SurfaceNode, to: SurfaceNode): SurfaceEdge {
  return {
    kind: 'EXPOSES',
    tenantId,
    provenance: provenance(RUN_ID),
    fromKey: naturalKey(from),
    toKey: naturalKey(to),
  };
}

// The seeded surface of RUN_ID in TENANT_A: one hub host exposing three services (degree 3 for the hub, 1 for each
// service), and two isolated hosts. `leaf-low` carries confidence 0.2, so a 0.5 floor drops it.
const HUB = host(TENANT_A, 'hub.example.test');
const LEAF = host(TENANT_A, 'leaf.example.test');
const LEAF_LOW = host(TENANT_A, 'leaf-low.example.test', RUN_ID, 0.2);
const SERVICES = [
  service(TENANT_A, 'hub.example.test', 22),
  service(TENANT_A, 'hub.example.test', 80),
  service(TENANT_A, 'hub.example.test', 443),
];
const ALL_NODES = [HUB, LEAF, LEAF_LOW, ...SERVICES];
const ALL_KEYS = ALL_NODES.map((node) => naturalKey(node));

beforeAll(async () => {
  neo = await withNeo4j();
  const config: Neo4jConfig = {
    uri: neo.boltUrl,
    username: neo.username,
    password: neo.password,
    database: 'neo4j',
    maxPoolSize: 10,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
  };
  runtime = createGraphRuntime(config, { logger: quietLogger });
  await withTenantGraph(
    TENANT_A,
    async (repo) => {
      for (const node of ALL_NODES) await repo.writeNode(node);
      for (const target of SERVICES) await repo.writeEdge(exposes(TENANT_A, HUB, target));
    },
    { runtime },
  );
  // A node of another run in the same tenant must never appear in RUN_ID's surface.
  await withTenantGraph(
    TENANT_A,
    (repo) => repo.writeNode(host(TENANT_A, 'other-run.example.test', OTHER_RUN_ID)),
    { runtime },
  );
}, 180_000);

afterAll(async () => {
  await runtime.driver.close();
  await neo.stop();
});

async function readAll(
  query: Partial<typeof QUERY> & { readonly kinds?: readonly ('host' | 'service')[] },
  runId = RUN_ID,
  tenantId = TENANT_A,
) {
  return withTenantGraph(tenantId, (repo) => repo.readRunSurface(runId, { ...QUERY, ...query }), {
    runtime,
  });
}

describe('run surface read against Neo4j 5', () => {
  it('reports full totals of the run and nothing of another run', async () => {
    const surface = await readAll({});
    expect(surface.totals).toEqual({ nodes: ALL_NODES.length, edges: SERVICES.length });
    expect(surface.nodes.map((entry) => naturalKey(entry.node))).not.toContain(
      naturalKey(host(TENANT_A, 'other-run.example.test', OTHER_RUN_ID)),
    );
  });

  it('ranks by degree, so the cap keeps the hub, and returns only edges within the kept nodes', async () => {
    const surface = await readAll({ nodeCap: 2, limit: 50, edgeCap: 4000 });
    expect(surface.totals.nodes).toBe(ALL_NODES.length);
    expect(surface.nodes).toHaveLength(2);
    const kept = new Set(surface.nodes.map((entry) => naturalKey(entry.node)));
    expect(kept.has(naturalKey(HUB))).toBe(true);
    expect(surface.nodes.find((entry) => naturalKey(entry.node) === naturalKey(HUB))?.degree).toBe(
      3,
    );
    for (const edge of surface.edges) {
      expect(kept.has(edge.fromKey)).toBe(true);
      expect(kept.has(edge.toKey)).toBe(true);
    }
  });

  it('pages by natural key without repeats or gaps across the retained set', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const surface = await readAll({
        limit: 2,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      seen.push(...surface.nodes.map((entry) => naturalKey(entry.node)));
      cursor = surface.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual([...ALL_KEYS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('keeps only the requested kinds and the edges between them', async () => {
    const surface = await readAll({ kinds: ['service'] });
    expect(surface.totals).toEqual({ nodes: SERVICES.length, edges: 0 });
    expect(surface.nodes.every((entry) => entry.node.kind === 'service')).toBe(true);
    expect(surface.edges).toEqual([]);
  });

  it('drops nodes and edges below the confidence floor', async () => {
    const surface = await readAll({ minConfidence: 0.5 });
    expect(surface.totals.nodes).toBe(ALL_NODES.length - 1);
    expect(surface.nodes.map((entry) => naturalKey(entry.node))).not.toContain(
      naturalKey(LEAF_LOW),
    );
  });

  it('marks an edge set above the edge cap as cut', async () => {
    const surface = await readAll({ edgeCap: 2 });
    expect(surface.edges).toHaveLength(2);
    expect(surface.edgesTruncated).toBe(true);
    expect(surface.totals.edges).toBe(SERVICES.length);
  });

  it('is invisible to another tenant (§8.6): the same run id has an empty surface there', async () => {
    const surface = await readAll({}, RUN_ID, TENANT_B);
    expect(surface).toEqual({
      totals: { nodes: 0, edges: 0 },
      nodes: [],
      edges: [],
      edgesTruncated: false,
    });
  });
});
