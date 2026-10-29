import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';

import type { AssessmentReadStore, AssessmentRequestQuery, AssessmentRequestRow } from './store.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
const ME = '0198f0a0-0000-7000-8000-0000000000a1';
const OTHER = '0198f0a0-0000-7000-8000-0000000000a2';
const OWNER = '0198f0a0-0000-7000-8000-0000000000a3';
const NOBODY = '0198f0a0-0000-7000-8000-0000000000a4';
const SA = '0198f0a0-0000-7000-8000-0000000000c1';
const ASSET = '0198f0a0-0000-7000-8000-0000000000d1';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [`${TENANT_A}:${ME}`]: ['developer'],
  [`${TENANT_A}:${OTHER}`]: ['developer'],
  [`${TENANT_A}:${OWNER}`]: ['org_admin'],
  [`${TENANT_B}:${ME}`]: ['developer'],
};

function row(id: string, overrides: Partial<AssessmentRequestRow> = {}): AssessmentRequestRow {
  return {
    id,
    publicId: `areq_${id.slice(-4)}`,
    mode: 'black',
    status: 'submitted',
    objective: 'Assess the login flow',
    assetIds: [ASSET],
    saId: SA,
    inputManifestId: null,
    maxIntrusiveness: 'passive',
    requestedBy: OTHER,
    createdAt: new Date(Date.UTC(2026, 0, 1) + parseInt(id.slice(-2), 16) * 1000),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
    ...overrides,
  };
}

const R = {
  a1: '0198f0a0-0000-7000-8000-0000000000e1',
  a2: '0198f0a0-0000-7000-8000-0000000000e2',
  a3: '0198f0a0-0000-7000-8000-0000000000e3',
  draftOther: '0198f0a0-0000-7000-8000-0000000000e4',
  draftMine: '0198f0a0-0000-7000-8000-0000000000e5',
  withdrawn: '0198f0a0-0000-7000-8000-0000000000e6',
};

/** Rows keyed by tenant. Tenant B's rows must never reach a tenant A caller. */
const ROWS: Readonly<Record<string, readonly AssessmentRequestRow[]>> = {
  [TENANT_A]: [
    row(R.a1, { status: 'submitted' }),
    row(R.a2, { status: 'withdrawn', mode: 'grey' }),
    row(R.a3, { status: 'submitted', saId: null }),
    row(R.draftOther, { status: 'draft', requestedBy: OTHER }),
    row(R.draftMine, { status: 'draft', requestedBy: ME }),
  ],
  [TENANT_B]: [row('0198f0a0-0000-7000-8000-0000000000f1', { status: 'submitted' })],
};

/** Mirrors the Postgres adapter: tenant-confined, draft visibility, status/mode filter, keyset, limit. */
function fakeAssessments(log: AssessmentRequestQuery[] = []): AssessmentReadStore {
  const visible = (r: AssessmentRequestRow, viewer: string, privileged: boolean) =>
    privileged || r.status !== 'draft' || r.requestedBy === viewer;
  return {
    rolesOf: (tenantId, userId) => Promise.resolve(ROLES[`${tenantId}:${userId}`] ?? []),
    listRequests(tenantId, query) {
      log.push(query);
      const rows = (ROWS[tenantId] ?? [])
        .filter((r) => query.status === undefined || r.status === query.status)
        .filter((r) => query.mode === undefined || r.mode === query.mode)
        .filter((r) => visible(r, query.viewerId, query.privileged))
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id > x.id ? 1 : -1))
        .filter(
          (r) =>
            query.after === undefined ||
            r.createdAt.getTime() < query.after.createdAt.getTime() ||
            (r.createdAt.getTime() === query.after.createdAt.getTime() && r.id < query.after.id),
        );
      return Promise.resolve(rows.slice(0, query.limit));
    },
    findRequest(tenantId, id, viewer) {
      const found = (ROWS[tenantId] ?? []).find(
        (r) => r.id === id && visible(r, viewer.viewerId, viewer.privileged),
      );
      return Promise.resolve(found);
    },
  };
}

function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant, user] = header.split(':');
  if (kind !== 'session' || tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

let current: ApiApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(assessments: AssessmentReadStore, env: Record<string, string> = {}) {
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000', ...env });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  const members = {
    listMembers: () => Promise.resolve([]),
    findUsers: () => Promise.resolve(new Map()),
  };
  const app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers['x-test-principal']),
    imports: [GraphqlApiModule.forRoot({ config, logger, metrics, store: members, assessments })],
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
  principal?: string,
  variables: Record<string, unknown> = {},
): Promise<GqlBody> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: {
      'content-type': 'application/json',
      ...(principal === undefined ? {} : { 'x-test-principal': principal }),
    },
    payload: { query, variables },
  });
  return res.json<GqlBody>();
}

const ME_A = `session:${TENANT_A}:${ME}`;
const OWNER_A = `session:${TENANT_A}:${OWNER}`;
const LIST = `query L($status: String, $first: Int, $after: String) {
  assessmentRequests(status: $status, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { cursor node { id status mode } }
  }
}`;

describe('assessment request GraphQL reads (SCOPE-001, API-009)', () => {
  it('lists only the caller tenant submitted requests for a status filter', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST, ME_A, { status: 'submitted' });
    expect(body.errors).toBeUndefined();
    const nodes = (
      body.data?.assessmentRequests as { edges: { node: { id: string } }[] }
    ).edges.map((edge) => edge.node.id);
    expect(nodes).toEqual([R.a3, R.a1]);
    expect(JSON.stringify(body)).not.toContain('0198f0a0-0000-7000-8000-0000000000f1');
  });

  it('answers an empty connection when nothing matches', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST, ME_A, { status: 'promoted' });
    expect(body.data).toEqual({
      assessmentRequests: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
    });
  });

  it('clamps first to the platform maximum of 200', async () => {
    const log: AssessmentRequestQuery[] = [];
    const app = await boot(fakeAssessments(log));
    await gql(app, LIST, ME_A, { first: 5000 });
    expect(log.at(-1)?.limit).toBe(201);
  });

  it('pages with an opaque cursor and reports hasNextPage', async () => {
    const app = await boot(fakeAssessments());
    const first = await gql(app, LIST, OWNER_A, { first: 2 });
    const page1 = first.data?.assessmentRequests as {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      edges: { node: { id: string } }[];
    };
    expect(page1.pageInfo.hasNextPage).toBe(true);
    expect(page1.edges).toHaveLength(2);
    const second = await gql(app, LIST, OWNER_A, { first: 2, after: page1.pageInfo.endCursor });
    const page2 = second.data?.assessmentRequests as typeof page1;
    expect(page2.pageInfo.hasNextPage).toBe(true);
    expect(page2.edges.map((e) => e.node.id)).not.toContain(page1.edges[0]?.node.id);
    const third = await gql(app, LIST, OWNER_A, {
      first: 2,
      after: page2.pageInfo.endCursor,
    });
    expect((third.data?.assessmentRequests as typeof page1).pageInfo.hasNextPage).toBe(false);
  });

  it('rejects a malformed cursor with validation_failed', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST, ME_A, { after: 'not-a-cursor' });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    expect(body.data).toBeNull();
  });

  it('rejects a non-positive first and an unknown status with validation_failed', async () => {
    const app = await boot(fakeAssessments());
    const zero = await gql(app, LIST, ME_A, { first: 0 });
    expect(zero.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    const unknown = await gql(app, LIST, ME_A, { status: 'deleted' });
    expect(unknown.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a caller with no membership in the tenant (fail closed)', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST, `session:${TENANT_A}:${NOBODY}`);
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
  });

  it('refuses an actor id that is not a UUID', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST, `session:${TENANT_A}:usr_test`);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
  });

  it('answers unauthenticated access with the unauthenticated code', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, LIST);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'unauthenticated' });
  });

  it('shows a draft only to its requester, and to every draft for a privileged role', async () => {
    const app = await boot(fakeAssessments());
    const idsOf = (body: GqlBody) =>
      (body.data?.assessmentRequests as { edges: { node: { id: string } }[] }).edges.map(
        (e) => e.node.id,
      );
    const mine = await gql(app, LIST, ME_A, { status: 'draft' });
    expect(idsOf(mine)).toEqual([R.draftMine]);
    const oversight = await gql(app, LIST, OWNER_A, { status: 'draft' });
    expect(idsOf(oversight).sort()).toEqual([R.draftMine, R.draftOther].sort());
  });

  it('resolves one request with its asset and standing authorisation references', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(
      app,
      `query One($id: ID!) { assessmentRequest(id: $id) {
        id publicId status objective maxIntrusiveness requestedBy createdAt updatedAt
        inputManifestId assets { id } standingAuthorisation { id } } }`,
      ME_A,
      { id: R.a1 },
    );
    expect(body.errors).toBeUndefined();
    expect(body.data?.assessmentRequest).toEqual({
      id: R.a1,
      publicId: row(R.a1).publicId,
      status: 'submitted',
      objective: 'Assess the login flow',
      maxIntrusiveness: 'passive',
      requestedBy: OTHER,
      createdAt: row(R.a1).createdAt.toISOString(),
      updatedAt: '2026-01-02T00:00:00.000Z',
      inputManifestId: null,
      assets: [{ id: ASSET }],
      standingAuthorisation: { id: SA },
    });
  });

  it('answers a null standing authorisation for a request without one', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(
      app,
      'query One($id: ID!) { assessmentRequest(id: $id) { standingAuthorisation { id } } }',
      ME_A,
      { id: R.a3 },
    );
    expect(body.data?.assessmentRequest).toEqual({ standingAuthorisation: null });
  });

  it('answers null, without leaking existence, for a foreign, missing or invisible id', async () => {
    const app = await boot(fakeAssessments());
    const query = 'query One($id: ID!) { assessmentRequest(id: $id) { id } }';
    const foreign = await gql(app, query, ME_A, { id: '0198f0a0-0000-7000-8000-0000000000f1' });
    const missing = await gql(app, query, ME_A, { id: '0198f0a0-0000-7000-8000-0000000000ff' });
    const notAnId = await gql(app, query, ME_A, { id: 'nope' });
    const otherDraft = await gql(app, query, ME_A, { id: R.draftOther });
    for (const body of [foreign, missing, notAnId, otherDraft]) {
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual({ assessmentRequest: null });
    }
  });

  it('defines no mutation for requests: a write is refused by validation', async () => {
    const app = await boot(fakeAssessments());
    const body = await gql(app, 'mutation { createAssessmentRequest { id } }', ME_A);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
  });
});
