// Unit: the tenant guard of the surface-graph repository (GRAPH-004). A fake driver records every session and query,
// so each test can prove that a refused call sent nothing to the server.
import neo4j, { type Driver, Neo4jError } from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import { naturalKey, type SurfaceEdge, type SurfaceNode } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import { createGraphRuntime, type GraphRuntime } from './driver.js';
import { SurfaceGraphRepository, withTenantGraph } from './repository.js';

import type { Neo4jConfig } from './config.js';

const TENANT_A = '018f2a6e-1c00-7000-8000-00000000000a';
const TENANT_B = '018f2a6e-1c00-7000-8000-00000000000b';
const RUN_ID = '018f2a6e-1c01-7000-8000-000000000001';
const PROVENANCE = {
  runId: RUN_ID,
  confidence: 0.9,
  firstSeenAt: '2026-10-29T10:00:00.000Z',
  lastSeenAt: '2026-10-29T10:05:00.000Z',
};

const HOST_A: SurfaceNode = {
  kind: 'host',
  tenantId: TENANT_A,
  provenance: PROVENANCE,
  hostname: 'api.example.test',
  inScope: true,
};
const EXPOSES_A: SurfaceEdge = {
  kind: 'EXPOSES',
  tenantId: TENANT_A,
  provenance: PROVENANCE,
  fromKey: naturalKey({ ...HOST_A }),
  toKey: `service:${TENANT_A}:api.example.test:443:tcp`,
};

const CONFIG: Neo4jConfig = {
  uri: 'bolt://graph.invalid:7687',
  username: 'neo4j',
  password: 'unused',
  database: 'neo4j',
  maxPoolSize: 5,
  connectionTimeoutMs: 1000,
  maxTxRetryMs: 1000,
};

interface FakeQuery {
  readonly mode: 'READ' | 'WRITE';
  readonly cypher: string;
  readonly params: Record<string, unknown>;
}

interface FakeGraph {
  readonly runtime: GraphRuntime;
  readonly queries: FakeQuery[];
  readonly sessions: { opened: number };
}

/** A runtime over a fake driver. Each query returns `rows`, or throws `failure` when one is given. */
function fakeGraph(rows: unknown[] = [], failure?: Error): FakeGraph {
  const queries: FakeQuery[] = [];
  const sessions = { opened: 0 };
  const run = (mode: 'READ' | 'WRITE') => ({
    run: (cypher: string, params: Record<string, unknown>) => {
      queries.push({ mode, cypher, params });
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({ records: rows });
    },
  });
  const driver = {
    session: () => {
      sessions.opened += 1;
      return {
        executeRead: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) => work(run('READ')),
        executeWrite: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) =>
          work(run('WRITE')),
        close: () => Promise.resolve(),
      };
    },
    close: () => Promise.resolve(),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = createGraphRuntime(CONFIG, {
    logger,
    createDriver: () => driver as unknown as Driver,
  });
  return { runtime, queries, sessions };
}

/** A record shaped like a Neo4j row whose `n` column is a node with these properties. */
function nodeRow(properties: Record<string, unknown>, column = 'n'): unknown {
  return { get: (key: string) => (key === column ? { properties } : undefined) };
}

/** The stored properties of {@link HOST_A}, as Neo4j would return them. */
const HOST_A_STORED = {
  kind: 'host',
  tenantId: TENANT_A,
  naturalKey: naturalKey(HOST_A),
  hostname: 'api.example.test',
  inScope: true,
  provenance_runId: RUN_ID,
  provenance_confidence: 0.9,
  provenance_firstSeenAt: PROVENANCE.firstSeenAt,
  provenance_lastSeenAt: PROVENANCE.lastSeenAt,
};

const RUN_QUERY = { minConfidence: 0, limit: 10, nodeCap: 2000, edgeCap: 4000 } as const;

/** A fake whose answer depends on the Cypher text, so one read can run several queries against it. */
function fakeGraphRouted(answer: (cypher: string) => unknown[]): FakeGraph {
  const queries: FakeQuery[] = [];
  const sessions = { opened: 0 };
  const run = (mode: 'READ' | 'WRITE') => ({
    run: (cypher: string, params: Record<string, unknown>) => {
      queries.push({ mode, cypher, params });
      return Promise.resolve({ records: answer(cypher) });
    },
  });
  const driver = {
    session: () => {
      sessions.opened += 1;
      return {
        executeRead: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) => work(run('READ')),
        executeWrite: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) =>
          work(run('WRITE')),
        close: () => Promise.resolve(),
      };
    },
    close: () => Promise.resolve(),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = createGraphRuntime(CONFIG, {
    logger,
    createDriver: () => driver as unknown as Driver,
  });
  return { runtime, queries, sessions };
}

/** A ranked-page row: the node column `n` and its `degree`. */
function rankedRow(properties: Record<string, unknown>, degree: number): unknown {
  return {
    get: (key: string) => (key === 'n' ? { properties } : key === 'degree' ? degree : undefined),
  };
}

/** A count row: the single `count` column. */
function countRow(count: number): unknown {
  return { get: (key: string) => (key === 'count' ? count : undefined) };
}

/** A relationship row of the page edge query. */
function edgeRow(kind: string, fromKey: string, toKey: string): unknown {
  return {
    get: (key: string) => ({ kind, fromKey, toKey })[key as 'kind' | 'fromKey' | 'toKey'],
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('surface-graph repository: run surface read (GRAPH-006)', () => {
  const SERVICE_KEY = `service:${TENANT_A}:api.example.test:443:tcp`;

  it('reads counts, the ranked page and the page edges in one snapshot, all bound to the ambient tenant', async () => {
    const graph = fakeGraphRouted((cypher) => {
      if (cypher.includes('count(n)')) return [countRow(3)];
      if (cypher.includes('count(r) AS count')) return [countRow(2)];
      if (cypher.includes('degree DESC')) return [rankedRow(HOST_A_STORED, 2)];
      return [edgeRow('EXPOSES', naturalKey(HOST_A), SERVICE_KEY)];
    });
    const repo = new SurfaceGraphRepository(graph.runtime);
    const surface = await withTenantGraph(TENANT_A, () => repo.readRunSurface(RUN_ID, RUN_QUERY), {
      runtime: graph.runtime,
    });

    expect(graph.sessions.opened).toBe(1);
    expect(graph.queries.map((q) => q.mode)).toEqual(['READ', 'READ', 'READ', 'READ']);
    for (const query of graph.queries) {
      expect(query.params.tenantId).toBe(TENANT_A);
      expect(query.params.runId).toBe(RUN_ID);
    }
    expect(surface.totals).toEqual({ nodes: 3, edges: 2 });
    expect(surface.nodes).toEqual([{ node: HOST_A, degree: 2 }]);
    expect(surface.nextCursor).toBeUndefined();
    expect(surface.edges).toEqual([
      { kind: 'EXPOSES', fromKey: naturalKey(HOST_A), toKey: SERVICE_KEY },
    ]);
    expect(surface.edgesTruncated).toBe(false);
  });

  it('sets nextCursor to the last node of a full page and reports a cut edge set', async () => {
    const second: SurfaceNode = { ...HOST_A, hostname: 'web.example.test' };
    const graph = fakeGraphRouted((cypher) => {
      if (cypher.includes('count(n)')) return [countRow(2)];
      if (cypher.includes('count(r) AS count')) return [countRow(0)];
      if (cypher.includes('degree DESC')) {
        return [rankedRow(HOST_A_STORED, 1), rankedRow(storedHost(second), 1)];
      }
      return [
        edgeRow('EXPOSES', naturalKey(HOST_A), SERVICE_KEY),
        edgeRow('EXPOSES', naturalKey(second), SERVICE_KEY),
      ];
    });
    const repo = new SurfaceGraphRepository(graph.runtime);
    const surface = await withTenantGraph(
      TENANT_A,
      () => repo.readRunSurface(RUN_ID, { ...RUN_QUERY, limit: 1, edgeCap: 1 }),
      { runtime: graph.runtime },
    );

    expect(surface.nodes.map((entry) => entry.node)).toEqual([HOST_A]);
    expect(surface.nextCursor).toBe(naturalKey(HOST_A));
    expect(surface.edges).toHaveLength(1);
    expect(surface.edgesTruncated).toBe(true);
    const edgeQuery = graph.queries.at(-1);
    expect(edgeQuery?.params.keys).toEqual([naturalKey(HOST_A)]);
    expect((edgeQuery?.params.limit as { toNumber(): number }).toNumber()).toBe(2);
  });

  it('sends the scope filter to every surface query, off unless the caller asks for in-scope only', async () => {
    const graph = fakeGraphRouted(() => []);
    const repo = new SurfaceGraphRepository(graph.runtime);
    await withTenantGraph(TENANT_A, () => repo.readRunSurface(RUN_ID, RUN_QUERY), {
      runtime: graph.runtime,
    });
    await withTenantGraph(
      TENANT_A,
      () => repo.readRunSurface(RUN_ID, { ...RUN_QUERY, inScopeOnly: true }),
      { runtime: graph.runtime },
    );
    const flags = graph.queries.map((q) => q.params.inScopeOnly);
    expect(flags.slice(0, 2)).toEqual([false, false]);
    expect(flags.slice(-2)).toEqual([true, true]);
  });

  it('sends no edge query for an empty surface and answers empty totals', async () => {
    const graph = fakeGraphRouted((cypher) =>
      cypher.includes('count(n)') || cypher.includes('count(r) AS count') ? [countRow(0)] : [],
    );
    const repo = new SurfaceGraphRepository(graph.runtime);
    const surface = await withTenantGraph(TENANT_A, () => repo.readRunSurface(RUN_ID, RUN_QUERY), {
      runtime: graph.runtime,
    });
    expect(surface).toEqual({
      totals: { nodes: 0, edges: 0 },
      nodes: [],
      edges: [],
      edgesTruncated: false,
    });
    expect(graph.queries.some((q) => q.cypher.includes('type(r)'))).toBe(false);
  });

  it.each([
    ['a non-UUID run id', 'not-a-uuid', RUN_QUERY],
    ['a confidence above 1', RUN_ID, { ...RUN_QUERY, minConfidence: 1.5 }],
    ['a page size of zero', RUN_ID, { ...RUN_QUERY, limit: 0 }],
    ['a page size above the list cap', RUN_ID, { ...RUN_QUERY, limit: 201 }],
    ['an unknown node kind', RUN_ID, { ...RUN_QUERY, kinds: ['database'] }],
  ])('refuses %s with VALIDATION_FAILED before any query', async (_name, runId, query) => {
    const graph = fakeGraphRouted(() => []);
    const repo = new SurfaceGraphRepository(graph.runtime);
    await withTenantGraph(
      TENANT_A,
      async () => {
        await expectCode(
          repo.readRunSurface(runId, query as unknown as typeof RUN_QUERY),
          'VALIDATION_FAILED',
        );
      },
      { runtime: graph.runtime },
    );
    expect(graph.queries).toHaveLength(0);
  });

  it('treats a stored edge with an unknown kind as a fault, not a validation error', async () => {
    const graph = fakeGraphRouted((cypher) => {
      if (cypher.includes('count(n)') || cypher.includes('count(r) AS count')) return [countRow(1)];
      if (cypher.includes('degree DESC')) return [rankedRow(HOST_A_STORED, 0)];
      return [edgeRow('LINKS_TO', naturalKey(HOST_A), SERVICE_KEY)];
    });
    const repo = new SurfaceGraphRepository(graph.runtime);
    await withTenantGraph(
      TENANT_A,
      () =>
        expect(repo.readRunSurface(RUN_ID, RUN_QUERY)).rejects.toMatchObject({
          code: 'GRAPH_QUERY_FAILED',
        }),
      { runtime: graph.runtime },
    );
  });
});

/** The stored properties of a host with another hostname (the second node of a page). */
function storedHost(node: SurfaceNode): Record<string, unknown> {
  return {
    ...HOST_A_STORED,
    naturalKey: naturalKey(node),
    hostname: node.kind === 'host' ? node.hostname : undefined,
  };
}

describe('surface-graph repository: tenant guard', () => {
  it.each([
    ['writeNode', (repo: SurfaceGraphRepository) => repo.writeNode(HOST_A)],
    ['writeEdge', (repo: SurfaceGraphRepository) => repo.writeEdge(EXPOSES_A)],
    ['getNode', (repo: SurfaceGraphRepository) => repo.getNode('host', naturalKey(HOST_A))],
    ['listNodes', (repo: SurfaceGraphRepository) => repo.listNodes('host', {}, { limit: 10 })],
    [
      'getNeighbours',
      (repo: SurfaceGraphRepository) => repo.getNeighbours(naturalKey(HOST_A), ['EXPOSES'], 1),
    ],
    ['countByTenant', (repo: SurfaceGraphRepository) => repo.countByTenant('host')],
    ['readRunSurface', (repo: SurfaceGraphRepository) => repo.readRunSurface(RUN_ID, RUN_QUERY)],
    ['summariseRuns', (repo: SurfaceGraphRepository) => repo.summariseRuns([RUN_ID])],
    [
      'listRunEndpoints',
      (repo: SurfaceGraphRepository) => repo.listRunEndpoints(RUN_ID, { limit: 10 }),
    ],
  ])(
    '%s without a tenant context throws GRAPH_NO_TENANT_CONTEXT before any query',
    async (_name, call) => {
      const graph = fakeGraph([nodeRow(HOST_A_STORED)]);
      const repo = new SurfaceGraphRepository(graph.runtime);
      await expectCode(call(repo), 'GRAPH_NO_TENANT_CONTEXT');
      expect(graph.sessions.opened).toBe(0);
      expect(graph.queries).toHaveLength(0);
    },
  );

  it('refuses a node write whose tenant is not the context tenant, with no query sent', async () => {
    const graph = fakeGraph();
    const otherTenantNode = { ...HOST_A, tenantId: TENANT_B };
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await expectCode(repo.writeNode(otherTenantNode), 'GRAPH_TENANT_MISMATCH');
      },
      { runtime: graph.runtime },
    );
    expect(graph.queries).toHaveLength(0);
  });

  it('refuses an edge whose tenant is not the context tenant, with no query sent', async () => {
    const graph = fakeGraph();
    const otherTenantEdge: SurfaceEdge = {
      ...EXPOSES_A,
      tenantId: TENANT_B,
      fromKey: `host:${TENANT_B}:api.example.test`,
      toKey: `service:${TENANT_B}:api.example.test:443:tcp`,
    };
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await expectCode(repo.writeEdge(otherTenantEdge), 'GRAPH_TENANT_MISMATCH');
      },
      { runtime: graph.runtime },
    );
    expect(graph.queries).toHaveLength(0);
  });

  it('binds the ambient tenant into every query and never a caller value', async () => {
    const graph = fakeGraph([]);
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await repo.listNodes('host', { inScope: true }, { limit: 10 });
        await repo.writeNode(HOST_A);
        await repo.countByTenant('host');
      },
      { runtime: graph.runtime },
    );
    expect(graph.queries.map((query) => query.mode)).toEqual(['READ', 'WRITE', 'READ']);
    for (const query of graph.queries) {
      expect(query.cypher).toContain('$tenantId');
      expect(query.params.tenantId).toBe(TENANT_A);
    }
  });
});

describe('surface-graph repository: input validation', () => {
  it.each([
    [
      'a bad node',
      (repo: SurfaceGraphRepository) => repo.writeNode({ ...HOST_A, hostname: '*.bad.test' }),
    ],
    ['an unknown node kind', (repo: SurfaceGraphRepository) => repo.getNode('ghost' as never, 'x')],
    ['an empty key', (repo: SurfaceGraphRepository) => repo.getNode('host', '')],
    [
      'a zero page size',
      (repo: SurfaceGraphRepository) => repo.listNodes('host', {}, { limit: 0 }),
    ],
    [
      'an oversized page',
      (repo: SurfaceGraphRepository) => repo.listNodes('host', {}, { limit: 201 }),
    ],
    [
      'a filter key that is not a property name',
      (repo: SurfaceGraphRepository) =>
        repo.listNodes('host', { 'a) DETACH DELETE n //': 1 }, { limit: 5 }),
    ],
    [
      'an object filter value',
      (repo: SurfaceGraphRepository) =>
        repo.listNodes('host', { inScope: { $gt: 0 } } as unknown as Record<string, string>, {
          limit: 5,
        }),
    ],
    [
      'depth 3',
      (repo: SurfaceGraphRepository) => repo.getNeighbours('k', ['EXPOSES'], 3 as unknown as 1),
    ],
    [
      'depth 0',
      (repo: SurfaceGraphRepository) => repo.getNeighbours('k', ['EXPOSES'], 0 as unknown as 1),
    ],
    ['no edge kinds', (repo: SurfaceGraphRepository) => repo.getNeighbours('k', [], 1)],
    [
      'an unknown edge kind',
      (repo: SurfaceGraphRepository) => repo.getNeighbours('k', ['DROP' as never], 1),
    ],
  ])('rejects %s with VALIDATION_FAILED and sends no query', async (_label, call) => {
    const graph = fakeGraph();
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await expectCode(call(repo), 'VALIDATION_FAILED');
      },
      { runtime: graph.runtime },
    );
    expect(graph.queries).toHaveLength(0);
  });
});

describe('surface-graph repository: results and failures', () => {
  it('returns a stored node parsed through the contract', async () => {
    const graph = fakeGraph([nodeRow(HOST_A_STORED)]);
    const node = await withTenantGraph(
      TENANT_A,
      (repo) => repo.getNode('host', naturalKey(HOST_A)),
      { runtime: graph.runtime },
    );
    expect(node).toEqual(HOST_A);
  });

  it('reports a stored node that fails the contract as GRAPH_QUERY_FAILED', async () => {
    const withoutRequired: Record<string, unknown> = { ...HOST_A_STORED };
    delete withoutRequired.inScope;
    const graph = fakeGraph([nodeRow(withoutRequired)]);
    const error: unknown = await withTenantGraph(
      TENANT_A,
      (repo) => repo.getNode('host', naturalKey(HOST_A)),
      { runtime: graph.runtime },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'GRAPH_QUERY_FAILED' });
  });

  it('pages with a keyset cursor and reports nextCursor only when more rows follow', async () => {
    const second = { ...HOST_A_STORED, hostname: 'web.example.test', naturalKey: 'host:x' };
    const graph = fakeGraph([nodeRow(HOST_A_STORED), nodeRow(second)]);
    const page = await withTenantGraph(
      TENANT_A,
      (repo) => repo.listNodes('host', {}, { limit: 1 }),
      { runtime: graph.runtime },
    );
    expect(page.nodes).toEqual([HOST_A]);
    expect(page.nextCursor).toBe(naturalKey(HOST_A));
    expect(graph.queries[0]?.params).toMatchObject({ after: null, filterKeys: [] });
    expect(graph.queries[0]?.params.limit).toEqual(neo4j.int(2));
  });

  it('maps a retriable driver failure to GRAPH_QUERY_UNAVAILABLE and a permanent one to GRAPH_QUERY_FAILED', async () => {
    const transient = new Neo4jError(
      'leader switched',
      'Neo.TransientError.Cluster.NotALeader',
      '50N42',
      'leader switched',
    );
    const transientGraph = fakeGraph([], transient);
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        await expectCode(repo.countByTenant('host'), 'GRAPH_QUERY_UNAVAILABLE');
      },
      { runtime: transientGraph.runtime },
    );

    const permanentGraph = fakeGraph([], new Error('syntax error near MATCH'));
    await withTenantGraph(
      TENANT_A,
      async (repo) => {
        const error: unknown = await repo.countByTenant('host').then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('GRAPH_QUERY_FAILED');
        expect((error as AppError).retryable).toBe(false);
        expect((error as AppError).message).not.toContain('syntax');
      },
      { runtime: permanentGraph.runtime },
    );
  });

  it('counts nodes of the ambient tenant', async () => {
    const graph = fakeGraph([{ get: (key: string) => (key === 'count' ? 3 : undefined) }]);
    const count = await withTenantGraph(TENANT_A, (repo) => repo.countByTenant('asset'), {
      runtime: graph.runtime,
    });
    expect(count).toBe(3);
    expect(graph.queries[0]?.cypher).toContain('Asset');
  });

  it('reports an edge as written only when both endpoints exist in the tenant', async () => {
    const written = fakeGraph([{ get: () => 1 }]);
    const missing = fakeGraph([{ get: () => 0 }]);
    await expect(
      withTenantGraph(TENANT_A, (repo) => repo.writeEdge(EXPOSES_A), { runtime: written.runtime }),
    ).resolves.toBe(true);
    await expect(
      withTenantGraph(TENANT_A, (repo) => repo.writeEdge(EXPOSES_A), { runtime: missing.runtime }),
    ).resolves.toBe(false);
  });

  it('keeps the neighbourhood cap and reports truncation', async () => {
    const rows = Array.from({ length: 101 }, (_, index) =>
      nodeRow({
        ...HOST_A_STORED,
        naturalKey: `host:${index}`,
        hostname: `h${index}.example.test`,
      }),
    );
    const graph = fakeGraph(rows);
    const result = await withTenantGraph(
      TENANT_A,
      (repo) => repo.getNeighbours(naturalKey(HOST_A), ['EXPOSES'], 2),
      { runtime: graph.runtime },
    );
    expect(result.nodes).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(graph.queries[0]?.cypher).toContain('*1..2');
    expect(graph.queries[0]?.params).toMatchObject({ edgeKinds: ['EXPOSES'] });
    expect(graph.queries[0]?.params.limit).toEqual(neo4j.int(101));
  });
});

describe('withTenantGraph', () => {
  it.each([
    ['an empty id', ''],
    ['a public ten_ id', 'ten_0123456789abcdef'],
    ['a non-uuid string', 'acme'],
    ['a unicode look-alike digit', '０18f2a6e-1c00-7000-8000-00000000000a'],
  ])('refuses %s as a tenant id', async (_label, tenantId) => {
    const graph = fakeGraph();
    await expect(
      withTenantGraph(tenantId, () => Promise.resolve(1), { runtime: graph.runtime }),
    ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
    expect(graph.sessions.opened).toBe(0);
  });

  it('refuses to nest a different tenant inside an active one', async () => {
    const graph = fakeGraph();
    await withTenantGraph(
      TENANT_A,
      async () => {
        await expect(
          withTenantGraph(TENANT_B, () => Promise.resolve(1), { runtime: graph.runtime }),
        ).rejects.toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
      },
      { runtime: graph.runtime },
    );
  });
});

/** A record of scalar columns, as Neo4j returns a row of `RETURN a AS x, b AS y`. */
function scalarRow(columns: Record<string, unknown>): unknown {
  return { get: (key: string) => columns[key] };
}

/** A runtime whose successive queries return the given record sets, in order (one set per query). */
function sequencedGraph(sets: readonly (readonly unknown[])[]): FakeGraph {
  const queries: FakeQuery[] = [];
  const sessions = { opened: 0 };
  let next = 0;
  const run = (mode: 'READ' | 'WRITE') => ({
    run: (cypher: string, params: Record<string, unknown>) => {
      queries.push({ mode, cypher, params });
      const records = sets[next] ?? [];
      next += 1;
      return Promise.resolve({ records });
    },
  });
  const driver = {
    session: () => {
      sessions.opened += 1;
      return {
        executeRead: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) => work(run('READ')),
        executeWrite: (work: (tx: ReturnType<typeof run>) => Promise<unknown>) =>
          work(run('WRITE')),
        close: () => Promise.resolve(),
      };
    },
    close: () => Promise.resolve(),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = createGraphRuntime(CONFIG, {
    logger,
    createDriver: () => driver as unknown as Driver,
  });
  return { runtime, queries, sessions };
}

const ENDPOINT_STORED = {
  kind: 'endpoint',
  tenantId: TENANT_A,
  naturalKey: `endpoint:${TENANT_A}:018f2a6e-1c02-7000-8000-000000000002:GET:/users/{id}`,
  assetId: '018f2a6e-1c02-7000-8000-000000000002',
  method: 'GET',
  pathTemplate: '/users/{id}',
  contentTypes: ['application/json'],
  authRequired: true,
  provenance_runId: RUN_ID,
  provenance_confidence: 0.8,
  provenance_firstSeenAt: PROVENANCE.firstSeenAt,
  provenance_lastSeenAt: PROVENANCE.lastSeenAt,
};

describe('surface-graph repository: run reads', () => {
  it('summariseRuns maps and orders the counts, drops empty technologies, and binds the tenant', async () => {
    // One record set per query, in the order the repository runs them: nodes, edges, technologies, endpoints.
    const graph = sequencedGraph([
      [
        scalarRow({ runId: RUN_ID, kind: 'service', count: neo4j.int(3) }),
        scalarRow({ runId: RUN_ID, kind: 'host', count: 2 }),
      ],
      [scalarRow({ runId: RUN_ID, kind: 'EXPOSES', count: 2 })],
      [
        scalarRow({ runId: RUN_ID, name: 'nginx', count: 2 }),
        scalarRow({ runId: RUN_ID, name: 'redis', count: 0 }),
        scalarRow({ runId: RUN_ID, name: 'express', count: 2 }),
      ],
      [scalarRow({ runId: RUN_ID, endpoints: neo4j.int(5), inScope: 3 })],
    ]);
    const summaries = await withTenantGraph(TENANT_A, (repo) => repo.summariseRuns([RUN_ID]), {
      runtime: graph.runtime,
    });
    expect(summaries.get(RUN_ID)).toEqual({
      runId: RUN_ID,
      nodeCounts: [
        { kind: 'host', count: 2 },
        { kind: 'service', count: 3 },
      ],
      edgeCounts: [{ kind: 'EXPOSES', count: 2 }],
      topTechnologies: [
        { name: 'express', count: 2 },
        { name: 'nginx', count: 2 },
      ],
      endpointCount: 5,
      inScopeEndpointCount: 3,
    });
    expect(graph.queries).toHaveLength(4);
    for (const query of graph.queries) {
      expect(query.mode).toBe('READ');
      expect(query.cypher).toContain('$tenantId');
      expect(query.params).toMatchObject({ tenantId: TENANT_A, runIds: [RUN_ID] });
    }
  });

  it('summariseRuns answers an empty summary for a run with no graph data, and sends no query for no runs', async () => {
    const graph = sequencedGraph([[], [], [], []]);
    const summaries = await withTenantGraph(TENANT_A, (repo) => repo.summariseRuns([RUN_ID]), {
      runtime: graph.runtime,
    });
    expect(summaries.get(RUN_ID)).toEqual({
      runId: RUN_ID,
      nodeCounts: [],
      edgeCounts: [],
      topTechnologies: [],
      endpointCount: 0,
      inScopeEndpointCount: 0,
    });
    const none = sequencedGraph([]);
    const empty = await withTenantGraph(TENANT_A, (repo) => repo.summariseRuns([]), {
      runtime: none.runtime,
    });
    expect(empty.size).toBe(0);
    expect(none.queries).toHaveLength(0);
  });

  it('summariseRuns caps the technology list at the most widely run ten', async () => {
    const technologies = Array.from({ length: 12 }, (_, index) =>
      scalarRow({
        runId: RUN_ID,
        name: `tech-${String(index).padStart(2, '0')}`,
        count: index + 1,
      }),
    );
    const graph = sequencedGraph([[], [], technologies, []]);
    const summaries = await withTenantGraph(TENANT_A, (repo) => repo.summariseRuns([RUN_ID]), {
      runtime: graph.runtime,
    });
    const top = summaries.get(RUN_ID)?.topTechnologies ?? [];
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ name: 'tech-11', count: 12 });
    expect(top.at(-1)).toEqual({ name: 'tech-02', count: 3 });
  });

  it('summariseRuns refuses a non-UUID run id and more runs than one batch holds, before any query', async () => {
    const graph = sequencedGraph([]);
    await expectCode(
      withTenantGraph(TENANT_A, (repo) => repo.summariseRuns(['not-a-run']), {
        runtime: graph.runtime,
      }),
      'VALIDATION_FAILED',
    );
    const tooMany = Array.from({ length: 101 }, () => RUN_ID);
    await expectCode(
      withTenantGraph(TENANT_A, (repo) => repo.summariseRuns(tooMany), { runtime: graph.runtime }),
      'VALIDATION_FAILED',
    );
    expect(graph.queries).toHaveLength(0);
  });

  it('summariseRuns fails closed on a stored kind outside the contract', async () => {
    const graph = sequencedGraph([
      [scalarRow({ runId: RUN_ID, kind: 'mystery', count: 1 })],
      [],
      [],
      [],
    ]);
    await expectCode(
      withTenantGraph(TENANT_A, (repo) => repo.summariseRuns([RUN_ID]), {
        runtime: graph.runtime,
      }),
      'GRAPH_QUERY_FAILED',
    );
    // The node-count read is the first statement, so the stored kind stops the summary before any later read.
    expect(graph.queries).toHaveLength(1);
  });

  it('listRunEndpoints pages by natural key and returns a cursor when more follow', async () => {
    const graph = sequencedGraph([
      [
        nodeRow(ENDPOINT_STORED),
        nodeRow({ ...ENDPOINT_STORED, naturalKey: 'endpoint:z' }),
        nodeRow({ ...ENDPOINT_STORED, naturalKey: 'endpoint:zz' }),
      ],
    ]);
    const page = await withTenantGraph(
      TENANT_A,
      (repo) => repo.listRunEndpoints(RUN_ID, { limit: 2 }),
      { runtime: graph.runtime },
    );
    expect(page.nodes).toHaveLength(2);
    expect(page.nodes[0]).toMatchObject({
      kind: 'endpoint',
      method: 'GET',
      pathTemplate: '/users/{id}',
    });
    expect(page.nextCursor).toBe(
      `endpoint:${TENANT_A}:018f2a6e-1c02-7000-8000-000000000002:GET:/users/{id}`,
    );
    expect(graph.queries[0]?.params).toMatchObject({
      tenantId: TENANT_A,
      runId: RUN_ID,
      after: null,
    });
  });

  it('listRunEndpoints refuses a non-UUID run id before any query', async () => {
    const graph = sequencedGraph([]);
    await expectCode(
      withTenantGraph(TENANT_A, (repo) => repo.listRunEndpoints('x', { limit: 2 }), {
        runtime: graph.runtime,
      }),
      'VALIDATION_FAILED',
    );
    expect(graph.queries).toHaveLength(0);
  });
});
