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
