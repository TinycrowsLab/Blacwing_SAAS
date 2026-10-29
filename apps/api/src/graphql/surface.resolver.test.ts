import { afterEach, describe, expect, it } from 'vitest';

import { naturalKey, type EndpointNode } from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';

import type { AssessmentReadStore, MemberReadStore, SurfaceReadStore } from './store.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { EndpointPage, RunSurfaceSummary } from '@blackwing/memory';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
const ME = '0198f0a0-0000-7000-8000-0000000000a1';
const NOBODY = '0198f0a0-0000-7000-8000-0000000000a4';
const ASSET = '0198f0a0-0000-7000-8000-0000000000d1';
const RUN_OWNED = '0198f0a0-0000-7000-8000-0000000000e1';
const RUN_EMPTY = '0198f0a0-0000-7000-8000-0000000000e2';
const RUN_OTHER_TENANT = '0198f0a0-0000-7000-8000-0000000000e3';
const RUN_MISSING = '0198f0a0-0000-7000-8000-0000000000e9';

const PROVENANCE = {
  runId: RUN_OWNED,
  confidence: 0.9,
  firstSeenAt: '2026-10-29T10:00:00.000Z',
  lastSeenAt: '2026-10-29T10:05:00.000Z',
};

const SUMMARY: RunSurfaceSummary = {
  runId: RUN_OWNED,
  nodeCounts: [
    { kind: 'host', count: 2 },
    { kind: 'service', count: 3 },
  ],
  edgeCounts: [{ kind: 'EXPOSES', count: 3 }],
  topTechnologies: [{ name: 'nginx', count: 2 }],
  endpointCount: 3,
  inScopeEndpointCount: 2,
};

function endpoint(path: string): EndpointNode {
  return {
    kind: 'endpoint',
    tenantId: TENANT_A,
    provenance: PROVENANCE,
    assetId: ASSET,
    method: 'GET',
    pathTemplate: path,
    contentTypes: ['application/json'],
    authRequired: true,
  };
}

/** Endpoints of the owned run, in natural-key order, as the repository returns them. */
const ENDPOINTS: EndpointNode[] = ['/a', '/b', '/c'].map((path) => endpoint(path));

const EMPTY_SUMMARY = (runId: string): RunSurfaceSummary => ({
  runId,
  nodeCounts: [],
  edgeCounts: [],
  topTechnologies: [],
  endpointCount: 0,
  inScopeEndpointCount: 0,
});

/** The run owner of each tenant. A run of another tenant is never summarised or paged for tenant A. */
const OWNED: Readonly<Record<string, readonly string[]>> = {
  [TENANT_A]: [RUN_OWNED, RUN_EMPTY],
  [TENANT_B]: [RUN_OTHER_TENANT],
};

interface SurfaceSpy {
  readonly summaryBatches: string[][];
  readonly endpointLimits: number[];
  readonly endpointAfters: (string | undefined)[];
  endpointReads: number;
}

/**
 * Mirrors the Postgres-and-graph adapter: a run is visible only to the tenant that owns it, summaries are returned
 * for owned runs only, and a page reads at most `limit` endpoints plus a cursor when more follow.
 */
function fakeSurface(spy: SurfaceSpy): SurfaceReadStore {
  return {
    rolesOf: (tenantId, userId) =>
      Promise.resolve(tenantId === TENANT_A && userId === ME ? ['developer'] : []),
    summariesOf(tenantId, runIds) {
      spy.summaryBatches.push([...runIds]);
      const owned = new Map<string, RunSurfaceSummary>();
      for (const runId of runIds) {
        if (!(OWNED[tenantId] ?? []).includes(runId)) continue;
        owned.set(runId, runId === RUN_OWNED ? SUMMARY : EMPTY_SUMMARY(runId));
      }
      return Promise.resolve(owned);
    },
    endpointsOf(tenantId, runId, page): Promise<EndpointPage | undefined> {
      spy.endpointReads += 1;
      spy.endpointLimits.push(page.limit);
      spy.endpointAfters.push(page.after);
      if (!(OWNED[tenantId] ?? []).includes(runId)) return Promise.resolve(undefined);
      if (runId !== RUN_OWNED) return Promise.resolve({ nodes: [] });
      const rest = ENDPOINTS.filter(
        (node) => page.after === undefined || naturalKey(node) > page.after,
      );
      const nodes = rest.slice(0, page.limit);
      const last = nodes.at(-1);
      const more = rest.length > page.limit && last !== undefined;
      return Promise.resolve(more ? { nodes, nextCursor: naturalKey(last) } : { nodes });
    },
  };
}

const NO_ASSESSMENTS: AssessmentReadStore = {
  rolesOf: () => Promise.resolve([]),
  listRequests: () => Promise.resolve([]),
  findRequest: () => Promise.resolve(undefined),
};

const NO_MEMBERS: MemberReadStore = {
  listMembers: () => Promise.resolve([]),
  findUsers: () => Promise.resolve(new Map()),
};

function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant, user] = header.split(':');
  if (kind !== 'session' || tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

function newSpy(): SurfaceSpy {
  return { summaryBatches: [], endpointLimits: [], endpointAfters: [], endpointReads: 0 };
}

let current: ApiApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(surface: SurfaceReadStore, env: Record<string, string> = {}): Promise<ApiApp> {
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000', ...env });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  const app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers['x-test-principal']),
    imports: [
      GraphqlApiModule.forRoot({
        config,
        logger,
        metrics,
        store: NO_MEMBERS,
        assessments: NO_ASSESSMENTS,
        surface,
      }),
    ],
  });
  await app.app.getHttpAdapter().getInstance().ready();
  current = app;
  return app;
}

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { message: string; extensions: Record<string, unknown> }[];
}

async function gql(
  app: ApiApp,
  query: string,
  principal: string,
  variables: Record<string, unknown> = {},
): Promise<GqlBody> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', 'x-test-principal': principal },
    payload: { query, variables },
  });
  return res.json<GqlBody>();
}

const ME_A = `session:${TENANT_A}:${ME}`;
const NOBODY_A = `session:${TENANT_A}:${NOBODY}`;

const SUMMARY_QUERY = `query S($runId: ID!) {
  surfaceSummary(runId: $runId) {
    runId
    nodeCounts { kind count }
    edgeCounts { kind count }
    topTechnologies { name count }
    endpointCount
    inScopeEndpointCount
  }
}`;

const ENDPOINTS_QUERY = `query E($runId: ID!, $first: Int, $after: String) {
  endpoints(runId: $runId, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node { method pathTemplate baseUrl authRequired contentTypes } }
  }
}`;

describe('surface GraphQL reads (GRAPH-004 / API-009)', () => {
  it('summarises one run: counts by kind, top technologies and endpoint totals', async () => {
    const app = await boot(fakeSurface(newSpy()));
    const body = await gql(app, SUMMARY_QUERY, ME_A, { runId: RUN_OWNED });
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      surfaceSummary: {
        runId: RUN_OWNED,
        nodeCounts: [
          { kind: 'host', count: 2 },
          { kind: 'service', count: 3 },
        ],
        edgeCounts: [{ kind: 'EXPOSES', count: 3 }],
        topTechnologies: [{ name: 'nginx', count: 2 }],
        endpointCount: 3,
        inScopeEndpointCount: 2,
      },
    });
    expect(JSON.stringify(body)).not.toContain(TENANT_A);
  });

  it('answers a zeroed summary and empty lists for an owned run with an empty surface', async () => {
    const app = await boot(fakeSurface(newSpy()));
    const summary = await gql(app, SUMMARY_QUERY, ME_A, { runId: RUN_EMPTY });
    expect(summary.errors).toBeUndefined();
    expect(summary.data?.surfaceSummary).toEqual({
      runId: RUN_EMPTY,
      nodeCounts: [],
      edgeCounts: [],
      topTechnologies: [],
      endpointCount: 0,
      inScopeEndpointCount: 0,
    });
    const page = await gql(app, ENDPOINTS_QUERY, ME_A, { runId: RUN_EMPTY });
    expect(page.data).toEqual({
      endpoints: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
    });
  });

  it('answers the same not_found for a foreign, a missing and a malformed run, so existence does not leak', async () => {
    const app = await boot(fakeSurface(newSpy()));
    const foreign = await gql(app, SUMMARY_QUERY, ME_A, { runId: RUN_OTHER_TENANT });
    const missing = await gql(app, SUMMARY_QUERY, ME_A, { runId: RUN_MISSING });
    const malformed = await gql(app, SUMMARY_QUERY, ME_A, { runId: 'not-a-uuid' });
    for (const body of [foreign, missing, malformed]) {
      expect(body.data).toBeNull();
      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'not_found' });
    }
    expect(foreign.errors?.[0]?.message).toBe(missing.errors?.[0]?.message);
    expect(missing.errors?.[0]?.message).toBe(malformed.errors?.[0]?.message);
  });

  it('refuses a caller without run:read in the tenant (fail closed) and reads nothing', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy));
    const body = await gql(app, SUMMARY_QUERY, NOBODY_A, { runId: RUN_OWNED });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
    expect(spy.summaryBatches).toHaveLength(0);
    const page = await gql(app, ENDPOINTS_QUERY, NOBODY_A, { runId: RUN_OWNED });
    expect(page.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
    expect(spy.endpointReads).toBe(0);
  });

  it('batches the summaries of several tiles in one request into one store read', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy));
    const body = await gql(
      app,
      `query Tiles($a: ID!, $b: ID!) {
        one: surfaceSummary(runId: $a) { endpointCount }
        two: surfaceSummary(runId: $a) { nodeCounts { kind } }
        three: surfaceSummary(runId: $b) { edgeCounts { kind } }
        four: surfaceSummary(runId: $a) { topTechnologies { name } }
      }`,
      ME_A,
      { a: RUN_OWNED, b: RUN_EMPTY },
    );
    expect(body.errors).toBeUndefined();
    expect(spy.summaryBatches).toEqual([[RUN_OWNED, RUN_EMPTY]]);
  });

  it('pages endpoints with an opaque cursor and reports hasNextPage', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy));
    const first = await gql(app, ENDPOINTS_QUERY, ME_A, { runId: RUN_OWNED, first: 2 });
    const connection = first.data?.endpoints as {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: { cursor: string; node: { pathTemplate: string } }[];
    };
    expect(connection.edges.map((edge) => edge.node.pathTemplate)).toEqual(['/a', '/b']);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    const cursor = connection.pageInfo.endCursor;
    expect(cursor).not.toBeNull();

    const second = await gql(app, ENDPOINTS_QUERY, ME_A, {
      runId: RUN_OWNED,
      first: 2,
      after: cursor,
    });
    const rest = second.data?.endpoints as {
      pageInfo: { hasNextPage: boolean };
      edges: { node: { pathTemplate: string } }[];
    };
    expect(rest.edges.map((edge) => edge.node.pathTemplate)).toEqual(['/c']);
    expect(rest.pageInfo.hasNextPage).toBe(false);
    expect(spy.endpointAfters.at(-1)).toBe(
      (JSON.parse(Buffer.from(cursor ?? '', 'base64url').toString('utf8')) as { k: string }).k,
    );
  });

  it('clamps first to the platform maximum of 200', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy));
    // A narrow selection, so the clamped page of 200 stays inside the default complexity budget.
    await gql(
      app,
      `query C($runId: ID!, $first: Int) { endpoints(runId: $runId, first: $first) { edges { cursor } } }`,
      ME_A,
      { runId: RUN_OWNED, first: 5000 },
    );
    expect(spy.endpointLimits).toEqual([200]);
  });

  it('rejects a non-positive first and a malformed cursor with validation_failed', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy));
    const zero = await gql(app, ENDPOINTS_QUERY, ME_A, { runId: RUN_OWNED, first: 0 });
    expect(zero.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    const forged = await gql(app, ENDPOINTS_QUERY, ME_A, {
      runId: RUN_OWNED,
      after: 'not-a-cursor!!',
    });
    expect(forged.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    expect(spy.endpointReads).toBe(0);
  });

  it('answers not_found for the endpoints of a foreign run without reading its endpoints as the caller', async () => {
    const app = await boot(fakeSurface(newSpy()));
    const body = await gql(app, ENDPOINTS_QUERY, ME_A, { runId: RUN_OTHER_TENANT });
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'not_found' });
  });

  it('rejects an endpoints query whose estimated cost exceeds the complexity limit before any read', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy), { API_GQL_MAX_COMPLEXITY: '20' });
    const body = await gql(
      app,
      `query Heavy($runId: ID!) {
        endpoints(runId: $runId, first: 200) { edges { node { method pathTemplate } } }
      }`,
      ME_A,
      { runId: RUN_OWNED },
    );
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
    expect(spy.endpointReads).toBe(0);
  });

  it('rejects a query deeper than the depth limit before any read', async () => {
    const spy = newSpy();
    const app = await boot(fakeSurface(spy), { API_GQL_MAX_DEPTH: '2' });
    const body = await gql(
      app,
      ENDPOINTS_QUERY.replace('pageInfo { hasNextPage endCursor }', '').replace(
        'node { method pathTemplate baseUrl authRequired contentTypes }',
        'node { method }',
      ),
      ME_A,
      {
        runId: RUN_OWNED,
      },
    );
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
    expect(spy.endpointReads).toBe(0);
  });
});
