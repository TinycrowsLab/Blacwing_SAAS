// Integration: the surface-graph repository against a real Neo4j 5 (`pnpm test:int`, Docker required). These tests are the
// mandatory §8.6 cross-tenant suite for the graph: a write under one tenant is invisible to every other tenant.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { naturalKey, type SurfaceEdge, type SurfaceNode } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';
import { type Neo4jHandle, withNeo4j } from '@blackwing/testing/containers';

import { createGraphRuntime, type GraphRuntime } from './driver.js';
import { NEIGHBOUR_LIMIT, withTenantGraph } from './repository.js';

import type { Neo4jConfig } from './config.js';

const TENANT_A = '018f2a6e-1c00-7000-8000-00000000000a';
const TENANT_B = '018f2a6e-1c00-7000-8000-00000000000b';
const TENANT_PAGING = '018f2a6e-1c00-7000-8000-00000000000c';
const RUN_ID = '018f2a6e-1c01-7000-8000-000000000001';
const ASSET_ID = '018f2a6e-1c02-7000-8000-000000000002';
const ROLE_ASSET_ID = '018f2a6e-1c02-7000-8000-000000000003';
const PROVENANCE = {
  runId: RUN_ID,
  confidence: 0.8,
  firstSeenAt: '2026-10-29T10:00:00.000Z',
  lastSeenAt: '2026-10-29T10:05:00.000Z',
};

let neo: Neo4jHandle;
let runtime: GraphRuntime;

function configFor(handle: Neo4jHandle): Neo4jConfig {
  return {
    uri: handle.boltUrl,
    username: handle.username,
    password: handle.password,
    database: 'neo4j',
    maxPoolSize: 10,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
  };
}

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function asset(tenantId: string, assetId = ASSET_ID): SurfaceNode {
  return { kind: 'asset', tenantId, provenance: PROVENANCE, assetId, type: 'web_app' };
}

function host(tenantId: string, hostname = 'api.example.test', inScope = true): SurfaceNode {
  return { kind: 'host', tenantId, provenance: PROVENANCE, hostname, inScope };
}

function service(tenantId: string, hostname = 'api.example.test'): SurfaceNode {
  return {
    kind: 'service',
    tenantId,
    provenance: PROVENANCE,
    hostname,
    port: 443,
    protocol: 'tcp',
    banner: 'nginx',
  };
}

function edge(
  kind: SurfaceEdge['kind'],
  tenantId: string,
  from: SurfaceNode,
  to: SurfaceNode,
): SurfaceEdge {
  const base = {
    tenantId,
    provenance: PROVENANCE,
    fromKey: naturalKey(from),
    toKey: naturalKey(to),
  };
  if (kind === 'CAN_ACCESS') return { ...base, kind, expected: 'deny' };
  return { ...base, kind };
}

beforeAll(async () => {
  neo = await withNeo4j();
  runtime = createGraphRuntime(configFor(neo), { logger: quietLogger });
}, 180_000);

afterAll(async () => {
  await runtime.driver.close();
  await neo.stop();
});

describe('surface-graph repository against Neo4j 5', () => {
  it('keeps a tenant write invisible to every other tenant (§8.6 cross-tenant suite)', async () => {
    const writer = host(TENANT_A);
    await withTenantGraph(TENANT_A, (repo) => repo.writeNode(writer), { runtime });

    await withTenantGraph(
      TENANT_B,
      async (repo) => {
        expect(await repo.getNode('host', naturalKey(writer))).toBeUndefined();
        expect((await repo.listNodes('host', {}, { limit: 50 })).nodes).toEqual([]);
        expect(await repo.countByTenant('host')).toBe(0);
        expect((await repo.getNeighbours(naturalKey(writer), ['EXPOSES'], 2)).nodes).toEqual([]);
      },
      { runtime },
    );

    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        expect(await repo.getNode('host', naturalKey(writer))).toEqual(writer);
        expect(await repo.countByTenant('host')).toBe(1);
      },
      { runtime },
    );
  });

  it('refuses a cross-tenant edge and never attaches it to another tenant node', async () => {
    const victim = host(TENANT_A, 'victim.example.test');
    await withTenantGraph(TENANT_A, (repo) => repo.writeNode(victim), { runtime });

    // The edge names tenant A's node but claims tenant B: the contract refuses the mismatch before any query.
    const forged = edge('EXPOSES', TENANT_B, victim, service(TENANT_B, 'victim.example.test'));
    await withTenantGraph(
      TENANT_B,
      async (repo) => {
        await expect(repo.writeEdge(forged)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      },
      { runtime },
    );
    expect(
      await withTenantGraph(TENANT_A, (repo) => repo.countByTenant('service'), { runtime }),
    ).toBe(0);
  });

  it('round-trips every node kind through the contract', async () => {
    const endpoint: SurfaceNode = {
      kind: 'endpoint',
      tenantId: TENANT_A,
      provenance: PROVENANCE,
      assetId: ASSET_ID,
      method: 'GET',
      pathTemplate: '/users/{id}',
      contentTypes: ['application/json'],
      authRequired: true,
    };
    const nodes: SurfaceNode[] = [
      asset(TENANT_A),
      host(TENANT_A),
      service(TENANT_A),
      {
        kind: 'technology',
        tenantId: TENANT_A,
        provenance: PROVENANCE,
        name: 'nginx',
        version: '1.25',
        categories: ['web-server'],
      },
      endpoint,
      {
        kind: 'parameter',
        tenantId: TENANT_A,
        provenance: PROVENANCE,
        endpointKey: naturalKey(endpoint),
        name: 'id',
        location: 'path',
        dataType: 'integer',
      },
      {
        kind: 'role',
        tenantId: TENANT_A,
        provenance: PROVENANCE,
        assetId: ROLE_ASSET_ID,
        roleName: 'admin',
      },
    ];
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        for (const node of nodes) await repo.writeNode(node);
        for (const node of nodes) {
          expect(await repo.getNode(node.kind, naturalKey(node))).toEqual(node);
        }
      },
      { runtime },
    );
  });

  it('upserts on the natural key: a second write updates, it does not duplicate', async () => {
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await repo.writeNode(host(TENANT_A, 'upsert.example.test', true));
        await repo.writeNode(host(TENANT_A, 'upsert.example.test', false));
        const stored = await repo.getNode(
          'host',
          naturalKey(host(TENANT_A, 'upsert.example.test')),
        );
        expect(stored).toMatchObject({ inScope: false });
        const page = await repo.listNodes(
          'host',
          { hostname: 'upsert.example.test' },
          { limit: 10 },
        );
        expect(page.nodes).toHaveLength(1);
      },
      { runtime },
    );
  });

  it('pages in natural-key order with a cursor and filters on top-level properties', async () => {
    const names = ['page-1', 'page-2', 'page-3', 'page-4', 'page-5'];
    await withTenantGraph(
      TENANT_PAGING,
      async (repo) => {
        for (const [index, name] of names.entries()) {
          await repo.writeNode(host(TENANT_PAGING, `${name}.example.test`, index % 2 === 0));
        }
        const seen: string[] = [];
        let after: string | undefined;
        do {
          const page = await repo.listNodes(
            'host',
            { inScope: true },
            after === undefined ? { limit: 2 } : { limit: 2, after },
          );
          seen.push(...page.nodes.map((node) => naturalKey(node)));
          after = page.nextCursor;
        } while (after !== undefined);
        expect(seen).toEqual(
          names
            .filter((_, index) => index % 2 === 0)
            .map((name) => naturalKey(host(TENANT_PAGING, `${name}.example.test`)))
            .sort(),
        );
      },
      { runtime },
    );
  });

  it('walks one and two hops over the requested edge kinds only', async () => {
    const assetNode = asset(TENANT_A, ASSET_ID);
    const hostNode = host(TENANT_A, 'walk.example.test');
    const serviceNode = service(TENANT_A, 'walk.example.test');
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await repo.writeNode(assetNode);
        await repo.writeNode(hostNode);
        await repo.writeNode(serviceNode);
        expect(await repo.writeEdge(edge('RESOLVES_TO', TENANT_A, assetNode, hostNode))).toBe(true);
        expect(await repo.writeEdge(edge('EXPOSES', TENANT_A, hostNode, serviceNode))).toBe(true);

        const oneHop = await repo.getNeighbours(naturalKey(assetNode), ['RESOLVES_TO'], 1);
        expect(oneHop.nodes.map((node) => node.kind)).toEqual(['host']);

        const twoHops = await repo.getNeighbours(
          naturalKey(assetNode),
          ['RESOLVES_TO', 'EXPOSES'],
          2,
        );
        expect(twoHops.nodes.map((node) => node.kind)).toEqual(['host', 'service']);
        expect(twoHops.truncated).toBe(false);

        const wrongKind = await repo.getNeighbours(naturalKey(assetNode), ['RUNS'], 2);
        expect(wrongKind.nodes).toEqual([]);

        const oneHopDepthCap = await repo.getNeighbours(
          naturalKey(assetNode),
          ['RESOLVES_TO', 'EXPOSES'],
          1,
        );
        expect(oneHopDepthCap.nodes.map((node) => node.kind)).toEqual(['host']);
      },
      { runtime },
    );
  });

  it('caps a large neighbourhood and reports truncation', async () => {
    const hub = asset(TENANT_A, '018f2a6e-1c02-7000-8000-0000000000ff');
    const spokes = Array.from({ length: NEIGHBOUR_LIMIT + 1 }, (_, index) =>
      host(TENANT_A, `spoke-${String(index).padStart(3, '0')}.example.test`),
    );
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await repo.writeNode(hub);
        for (const spoke of spokes) {
          await repo.writeNode(spoke);
          await repo.writeEdge(edge('RESOLVES_TO', TENANT_A, hub, spoke));
        }
        const result = await repo.getNeighbours(naturalKey(hub), ['RESOLVES_TO'], 1);
        expect(result.nodes).toHaveLength(NEIGHBOUR_LIMIT);
        expect(result.truncated).toBe(true);
      },
      { runtime },
    );
  });

  it('counts only the ambient tenant and rejects a missing edge endpoint without writing', async () => {
    await withTenantGraph(
      TENANT_B,
      async (repo) => {
        await repo.writeNode(host(TENANT_B, 'only-b.example.test'));
        const orphan = edge(
          'EXPOSES',
          TENANT_B,
          host(TENANT_B, 'no-such.example.test'),
          service(TENANT_B, 'no-such.example.test'),
        );
        expect(await repo.writeEdge(orphan)).toBe(false);
        expect(await repo.countByTenant('service')).toBe(0);
        expect(await repo.countByTenant('host')).toBeGreaterThan(0);
      },
      { runtime },
    );
  });

  it('rejects an over-long key as a typed validation error before any query', async () => {
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        const failure: unknown = await repo.getNode('host', 'x'.repeat(4097)).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(failure).toBeInstanceOf(AppError);
        expect((failure as AppError).code).toBe('VALIDATION_FAILED');
      },
      { runtime },
    );
  });
});

// Run summaries and endpoint pages (GRAPH-004 read model for the GraphQL surface) against the same Neo4j.
const SUMMARY_TENANT = '018f2a6e-1c00-7000-8000-00000000000d';
const SUMMARY_OTHER_TENANT = '018f2a6e-1c00-7000-8000-00000000000e';
const RUN_S1 = '018f2a6e-1c01-7000-8000-0000000000a1';
const RUN_S2 = '018f2a6e-1c01-7000-8000-0000000000a2';
const RUN_S_EMPTY = '018f2a6e-1c01-7000-8000-0000000000a3';
const ASSET_IN = '018f2a6e-1c02-7000-8000-0000000000b1';
const ASSET_OUT = '018f2a6e-1c02-7000-8000-0000000000b2';

function provenanceOf(runId: string) {
  return { ...PROVENANCE, runId };
}

function linked(
  kind: SurfaceEdge['kind'],
  tenantId: string,
  from: SurfaceNode,
  to: SurfaceNode,
  runId: string,
): SurfaceEdge {
  const base = {
    tenantId,
    provenance: provenanceOf(runId),
    fromKey: naturalKey(from),
    toKey: naturalKey(to),
  };
  if (kind === 'CAN_ACCESS') return { ...base, kind, expected: 'deny' };
  return { ...base, kind };
}

function endpointOf(
  tenantId: string,
  runId: string,
  assetId: string,
  method: string,
  path: string,
): SurfaceNode {
  return {
    kind: 'endpoint',
    tenantId,
    provenance: provenanceOf(runId),
    assetId,
    method: method as 'GET',
    pathTemplate: path,
    contentTypes: [],
    authRequired: false,
  };
}

/** Writes run S1 (two assets, two hosts, three services, two technologies, two endpoints) and a single host for S2. */
async function seedSummaryTenant(): Promise<void> {
  const assetIn: SurfaceNode = {
    kind: 'asset',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    assetId: ASSET_IN,
    type: 'web_app',
  };
  const assetOut: SurfaceNode = {
    kind: 'asset',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    assetId: ASSET_OUT,
    type: 'web_app',
  };
  const hostIn: SurfaceNode = {
    kind: 'host',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    hostname: 'in.example.test',
    inScope: true,
  };
  const hostOut: SurfaceNode = {
    kind: 'host',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    hostname: 'out.example.test',
    inScope: false,
  };
  const svcIn: SurfaceNode = {
    kind: 'service',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    hostname: 'in.example.test',
    port: 443,
    protocol: 'tcp',
  };
  const svcInAlt: SurfaceNode = {
    kind: 'service',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    hostname: 'in.example.test',
    port: 8443,
    protocol: 'tcp',
  };
  const nginx: SurfaceNode = {
    kind: 'technology',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    name: 'nginx',
    version: '1.25',
    categories: [],
  };
  const postgres: SurfaceNode = {
    kind: 'technology',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S1),
    name: 'postgres',
    categories: [],
  };
  const endpointIn = endpointOf(SUMMARY_TENANT, RUN_S1, ASSET_IN, 'GET', '/a');
  const endpointOut = endpointOf(SUMMARY_TENANT, RUN_S1, ASSET_OUT, 'POST', '/b');
  const hostOnlyS2: SurfaceNode = {
    kind: 'host',
    tenantId: SUMMARY_TENANT,
    provenance: provenanceOf(RUN_S2),
    hostname: 'second.example.test',
    inScope: true,
  };
  const nodes = [
    assetIn,
    assetOut,
    hostIn,
    hostOut,
    svcIn,
    svcInAlt,
    nginx,
    postgres,
    endpointIn,
    endpointOut,
    hostOnlyS2,
  ];
  const edges = [
    linked('RESOLVES_TO', SUMMARY_TENANT, assetIn, hostIn, RUN_S1),
    linked('RESOLVES_TO', SUMMARY_TENANT, assetOut, hostOut, RUN_S1),
    linked('EXPOSES', SUMMARY_TENANT, hostIn, svcIn, RUN_S1),
    linked('EXPOSES', SUMMARY_TENANT, hostIn, svcInAlt, RUN_S1),
    linked('RUNS', SUMMARY_TENANT, svcIn, nginx, RUN_S1),
    linked('RUNS', SUMMARY_TENANT, svcInAlt, nginx, RUN_S1),
    linked('RUNS', SUMMARY_TENANT, svcIn, postgres, RUN_S1),
    linked('SERVES', SUMMARY_TENANT, svcIn, endpointIn, RUN_S1),
  ];
  await withTenantGraph(
    SUMMARY_TENANT,
    async (repo) => {
      for (const node of nodes) await repo.writeNode(node);
      for (const link of edges) expect(await repo.writeEdge(link)).toBe(true);
    },
    { runtime },
  );
}

/** The count of a kind; a kind a run does not hold is absent from the list and counts as zero. */
function countOf<K extends string>(counts: readonly { kind: K; count: number }[], kind: K): number {
  return counts.find((entry) => entry.kind === kind)?.count ?? 0;
}

describe('surface summaries and endpoint pages against Neo4j 5 (GRAPH-004)', () => {
  it('counts every kind of a run, tenant-pinned, and zeroes the kinds and runs it does not hold', async () => {
    await seedSummaryTenant();
    const summaries = await withTenantGraph(
      SUMMARY_TENANT,
      (repo) => repo.summariseRuns([RUN_S1, RUN_S2, RUN_S_EMPTY]),
      { runtime },
    );

    const s1 = summaries.get(RUN_S1);
    // Only the kinds the run holds are listed, in kind order (a kind with no nodes is omitted, not zero).
    expect(s1?.nodeCounts.map((entry) => entry.kind)).toEqual([
      'asset',
      'endpoint',
      'host',
      'service',
      'technology',
    ]);
    expect(countOf(s1?.nodeCounts ?? [], 'asset')).toBe(2);
    expect(countOf(s1?.nodeCounts ?? [], 'host')).toBe(2);
    expect(countOf(s1?.nodeCounts ?? [], 'service')).toBe(2);
    expect(countOf(s1?.nodeCounts ?? [], 'technology')).toBe(2);
    expect(countOf(s1?.nodeCounts ?? [], 'endpoint')).toBe(2);
    expect(countOf(s1?.nodeCounts ?? [], 'parameter')).toBe(0);
    expect(countOf(s1?.edgeCounts ?? [], 'RUNS')).toBe(3);
    expect(countOf(s1?.edgeCounts ?? [], 'RESOLVES_TO')).toBe(2);
    expect(countOf(s1?.edgeCounts ?? [], 'SERVES')).toBe(1);
    expect(countOf(s1?.edgeCounts ?? [], 'CAN_ACCESS')).toBe(0);

    // nginx runs on two services, postgres on one: most widely run first.
    expect(s1?.topTechnologies).toEqual([
      { name: 'nginx', count: 2 },
      { name: 'postgres', count: 1 },
    ]);
    // Endpoint /a is served by a service on the in-scope host; /b belongs to an out-of-scope asset.
    expect(s1?.endpointCount).toBe(2);
    expect(s1?.inScopeEndpointCount).toBe(1);

    expect(summaries.get(RUN_S2)?.endpointCount).toBe(0);
    expect(countOf(summaries.get(RUN_S2)?.nodeCounts ?? [], 'host')).toBe(1);
    expect(summaries.get(RUN_S_EMPTY)).toEqual({
      runId: RUN_S_EMPTY,
      nodeCounts: [],
      edgeCounts: [],
      topTechnologies: [],
      endpointCount: 0,
      inScopeEndpointCount: 0,
    });
    expect(summaries.has('018f2a6e-1c01-7000-8000-0000000000ff')).toBe(false);
  });

  it('never summarises another tenant: the same run id reads as an empty surface there', async () => {
    const summaries = await withTenantGraph(
      SUMMARY_OTHER_TENANT,
      (repo) => repo.summariseRuns([RUN_S1]),
      { runtime },
    );
    expect(summaries.get(RUN_S1)).toEqual({
      runId: RUN_S1,
      nodeCounts: [],
      edgeCounts: [],
      topTechnologies: [],
      endpointCount: 0,
      inScopeEndpointCount: 0,
    });
  });

  it('pages a run endpoints by natural key and resumes after the cursor, never across runs', async () => {
    const first = await withTenantGraph(
      SUMMARY_TENANT,
      (repo) => repo.listRunEndpoints(RUN_S1, { limit: 1 }),
      { runtime },
    );
    expect(first.nodes).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await withTenantGraph(
      SUMMARY_TENANT,
      (repo) =>
        repo.listRunEndpoints(RUN_S1, {
          limit: 1,
          ...(first.nextCursor === undefined ? {} : { after: first.nextCursor }),
        }),
      { runtime },
    );
    expect(second.nodes).toHaveLength(1);
    expect(second.nodes[0]?.pathTemplate).not.toBe(first.nodes[0]?.pathTemplate);
    expect(second.nextCursor).toBeUndefined();

    const foreign = await withTenantGraph(
      SUMMARY_OTHER_TENANT,
      (repo) => repo.listRunEndpoints(RUN_S1, { limit: 10 }),
      { runtime },
    );
    expect(foreign.nodes).toEqual([]);
  });
});
