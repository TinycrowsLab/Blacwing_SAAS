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

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
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
