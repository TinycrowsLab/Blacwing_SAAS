// GraphQL dashboard reads through the real schema, guards, limits and DataLoader (DASH-001), over an in-memory store.
// The SQL, RLS and tenant isolation of the store are proven against Postgres in dashboard.rls.int.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { DashboardService } from './service.js';
import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  APPSEC_A,
  DEV_A,
  NOROLE_A,
  TENANT_A,
  TENANT_B,
  APPSEC_B,
  findingRow,
  memoryMemberships,
  uuidOf,
} from '../findings/fixtures.test-helpers.js';
import { GraphqlApiModule } from '../graphql/module.js';
import { createCursorCodec } from '../pagination/index.js';

import type { DashboardStore } from './ports.js';
import type { CoverageManifestRow, FindingSummaryRows, TrendRow } from '@blackwing/db';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';

const CURSOR_SECRET = 'k'.repeat(40);
const ASSET_A = uuidOf(0xe1);
const ASSET_B = uuidOf(0xe2);
const RUN = uuidOf(0xc1);

function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant, user] = header.split(':');
  if (kind !== 'session' || tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

const SUMMARY_ROWS: FindingSummaryRows = {
  total: 3,
  severity: [
    { key: 'high', count: 1 },
    { key: 'none', count: 1 },
    { key: null, count: 1 },
  ],
  owaspCategory: [{ key: 'A03', count: 2 }],
  cweId: [{ key: null, count: 3 }],
  assetId: [
    { key: ASSET_A, count: 2 },
    { key: ASSET_B, count: 1 },
  ],
  status: [{ key: 'confirmed', count: 3 }],
  baselineStatus: [{ key: null, count: 3 }],
};

/** A store that answers fixed rows and records every call, so a test can assert the tenant and visibility it got. */
function fakeStore(overrides: Partial<DashboardStore> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <T>(method: string, value: T) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(value);
    };
  const store: DashboardStore = {
    summary: record('summary', SUMMARY_ROWS),
    trend: record<TrendRow[]>('trend', []),
    coverageOfRun: record<CoverageManifestRow | undefined>('coverageOfRun', undefined),
    latestCoverageOfAsset: record<CoverageManifestRow | undefined>(
      'latestCoverageOfAsset',
      undefined,
    ) as DashboardStore['latestCoverageOfAsset'],
    connection: record('connection', [findingRow(1), findingRow(2)]),
    assetNames: record(
      'assetNames',
      new Map([
        [ASSET_A, 'Checkout'],
        [ASSET_B, 'Payments'],
      ]),
    ),
    ...overrides,
  };
  return { store, calls };
}

const memberships = memoryMemberships({
  [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [DEV_A]: ['developer'], [NOROLE_A]: [] },
  [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
});

let current: ApiApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(
  options: {
    readonly env?: Record<string, string>;
    readonly store?: DashboardStore;
    readonly withDashboard?: boolean;
  } = {},
) {
  const env = { NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000', ...options.env };
  const config = loadApiConfig(env);
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  const fake = fakeStore();
  const store = options.store ?? fake.store;
  const dashboard = new DashboardService({
    store,
    memberships,
    cursors: createCursorCodec(CURSOR_SECRET),
    metrics: { observe: vi.fn() },
    logger,
  });
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
        store: {
          listMembers: () => Promise.resolve([]),
          findUsers: () => Promise.resolve(new Map()),
        },
        assessments: {
          rolesOf: () => Promise.resolve([]),
          listRequests: () => Promise.resolve([]),
          findRequest: () => Promise.resolve(undefined),
        },
        surface: {
          rolesOf: () => Promise.resolve([]),
          summariesOf: () => Promise.resolve(new Map()),
          endpointsOf: () => Promise.resolve(undefined),
        },
        ...(options.withDashboard === false ? {} : { dashboard }),
      }),
    ],
  });
  await app.app.getHttpAdapter().getInstance().ready();
  current = app;
  return { app, calls: fake.calls, fake };
}

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { message: string; extensions: Record<string, unknown> }[];
}

async function gql(app: ApiApp, query: string, who?: string): Promise<GqlBody> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: {
      'content-type': 'application/json',
      ...(who === undefined ? {} : { 'x-test-principal': who }),
    },
    payload: { query, variables: {} },
  });
  return res.json<GqlBody>();
}

const ANALYST = `session:${TENANT_A}:${APPSEC_A}`;
const DEVELOPER = `session:${TENANT_A}:${DEV_A}`;
const NO_ROLE = `session:${TENANT_A}:${NOROLE_A}`;
const OTHER_TENANT_ANALYST = `session:${TENANT_B}:${APPSEC_B}`;

const SUMMARY = `{
  findingSummary(filter: { owaspCategories: ["A03"] }) {
    total
    bySeverity { key count }
    byCweId { key count }
    byAsset { assetId count assetName }
    byBaselineStatus { key count }
  }
}`;

describe('GraphQL dashboard: findingSummary', () => {
  it('answers grouped counts with the named buckets and the asset names', async () => {
    const { app } = await boot();
    const body = await gql(app, SUMMARY, ANALYST);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      findingSummary: {
        total: 3,
        bySeverity: [
          { key: 'high', count: 1 },
          { key: 'info', count: 1 },
          { key: 'unscored', count: 1 },
        ],
        byCweId: [{ key: 'uncategorised', count: 3 }],
        byAsset: [
          { assetId: ASSET_A, count: 2, assetName: 'Checkout' },
          { assetId: ASSET_B, count: 1, assetName: 'Payments' },
        ],
        byBaselineStatus: [{ key: 'not_retested', count: 3 }],
      },
    });
  });

  it('resolves every asset name of one request through a single batched read (DataLoader)', async () => {
    const { app, calls } = await boot();
    await gql(app, SUMMARY, ANALYST);
    expect(calls.filter((call) => call.method === 'assetNames')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'assetNames')?.args[0]).toBe(TENANT_A);
  });

  it('reads only the caller tenant, and hides suspected findings from a developer', async () => {
    const { app, calls } = await boot();
    await gql(app, SUMMARY, DEVELOPER);
    const summary = calls.find((call) => call.method === 'summary');
    expect(summary?.args[0]).toBe(TENANT_A);
    expect(summary?.args[2]).toEqual(['suspected']);
  });

  it('refuses a caller with no role in the tenant, and a caller of another tenant', async () => {
    const { app, calls } = await boot();
    const noRole = await gql(app, SUMMARY, NO_ROLE);
    expect(noRole.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
    // A tenant B analyst who presents a session of tenant A holds no role there, so tenant A is not read.
    const foreign = await gql(app, SUMMARY, `session:${TENANT_A}:${APPSEC_B}`);
    expect(foreign.data).toBeNull();
    expect(foreign.errors?.[0]?.extensions).toMatchObject({ code: 'permission_denied' });
    expect(calls.filter((call) => call.method === 'summary')).toHaveLength(0);
    // The same user in its own tenant reads that tenant only.
    await gql(app, SUMMARY, OTHER_TENANT_ANALYST);
    expect(calls.find((call) => call.method === 'summary')?.args[0]).toBe(TENANT_B);
  });

  it('refuses an unauthenticated request before any read', async () => {
    const { app, calls } = await boot();
    const body = await gql(app, SUMMARY);
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'unauthenticated' });
    expect(calls).toHaveLength(0);
  });

  it('takes no tenant from the client: a tenant argument is refused by the schema', async () => {
    const { app, calls } = await boot();
    const body = await gql(app, `{ findingSummary(tenantId: "${TENANT_B}") { total } }`, ANALYST);
    expect(body.errors?.[0]?.message).toMatch(/tenantId/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a filter with an unknown value and names the field, reading nothing', async () => {
    const { app, calls } = await boot();
    const body = await gql(
      app,
      '{ findingSummary(filter: { severities: [severe] }) { total } }',
      ANALYST,
    );
    expect(body.errors).toBeDefined();
    expect(calls.filter((call) => call.method === 'summary')).toHaveLength(0);
  });

  it('is refused by the depth limit before it runs (the global query limits apply)', async () => {
    const { app, calls } = await boot({ env: { API_GQL_MAX_DEPTH: '2' } });
    const body = await gql(app, '{ findingSummary { bySeverity { key } } }', ANALYST);
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
    expect(calls).toHaveLength(0);
  });

  it('fails closed when the dashboards are not configured', async () => {
    const { app } = await boot({ withDashboard: false });
    const body = await gql(app, SUMMARY, ANALYST);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'graph_query_unavailable' });
  });
});

describe('GraphQL dashboard: findingTrend and coverageSummary', () => {
  it('answers a trend for an asset, bucketed by a named enum value', async () => {
    const { app, calls } = await boot();
    const body = await gql(
      app,
      `{ findingTrend(assetId: "${ASSET_A}", bucket: week) { assetId bucket points { bucketStart total } } }`,
      ANALYST,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      findingTrend: { assetId: ASSET_A, bucket: 'week', points: [] },
    });
    expect(calls.find((call) => call.method === 'trend')?.args).toEqual([
      TENANT_A,
      ASSET_A,
      'week',
      [],
    ]);
  });

  it('refuses a bucket outside day and week at the schema', async () => {
    const { app, calls } = await boot();
    const body = await gql(
      app,
      `{ findingTrend(assetId: "${ASSET_A}", bucket: month) { points { total } } }`,
      ANALYST,
    );
    expect(body.errors).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('reports a finalised run with its percentage, and a run with no manifest as not finalised', async () => {
    const manifest: CoverageManifestRow = {
      id: uuidOf(0x7001),
      tenantId: TENANT_A,
      runId: RUN,
      entries: [
        { testCaseRef: 'tc-1', status: 'tested', reason: null },
        { testCaseRef: 'tc-2', status: 'tested', reason: null },
        { testCaseRef: 'tc-3', status: 'tested', reason: null },
        { testCaseRef: 'tc-4', status: 'not_tested', reason: 'out of scope' },
      ],
      finalisedAt: new Date('2026-10-29T11:00:00.000Z'),
      createdAt: new Date('2026-10-29T10:00:00.000Z'),
      updatedAt: new Date('2026-10-29T10:00:00.000Z'),
    };
    const { app } = await boot({
      store: fakeStore({ coverageOfRun: () => Promise.resolve(manifest) }).store,
    });
    const body = await gql(
      app,
      `{ coverageSummary(runId: "${RUN}") { finalised coveragePercent testCasesPlanned } }`,
      ANALYST,
    );
    expect(body.data).toEqual({
      coverageSummary: { finalised: true, coveragePercent: 75, testCasesPlanned: 4 },
    });
    const missing = await boot();
    const none = await gql(
      missing.app,
      `{ coverageSummary(runId: "${RUN}") { finalised coveragePercent testCasesPlanned } }`,
      ANALYST,
    );
    expect(none.data).toEqual({
      coverageSummary: { finalised: false, coveragePercent: null, testCasesPlanned: null },
    });
  });

  it('requires exactly one of runId and assetId', async () => {
    const { app } = await boot();
    const neither = await gql(app, '{ coverageSummary { finalised } }', ANALYST);
    expect(neither.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    const both = await gql(
      app,
      `{ coverageSummary(runId: "${RUN}", assetId: "${ASSET_A}") { finalised } }`,
      ANALYST,
    );
    expect(both.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
  });
});

describe('GraphQL dashboard: findingsConnection', () => {
  it('pages with a signed cursor, and the store receives the keyset of the page before', async () => {
    const { app, calls } = await boot();
    const first = await gql(
      app,
      '{ findingsConnection(limit: 1) { hasMore nextCursor items { id status } } }',
      ANALYST,
    );
    const page = first.data?.findingsConnection as {
      hasMore: boolean;
      nextCursor: string | null;
      items: { id: string }[];
    };
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const second = await gql(
      app,
      `{ findingsConnection(limit: 1, cursor: "${page.nextCursor ?? ''}") { items { id } } }`,
      ANALYST,
    );
    expect(second.errors).toBeUndefined();
    const connectionCalls = calls.filter((call) => call.method === 'connection');
    expect(connectionCalls[1]?.args[4]).toEqual({
      createdAt: findingRow(1).createdAt,
      id: findingRow(1).id,
    });
  });

  it('refuses a cursor replayed on another filter, and a page size over the maximum', async () => {
    const { app } = await boot();
    const first = await gql(app, '{ findingsConnection(limit: 1) { nextCursor } }', ANALYST);
    const cursor = (first.data?.findingsConnection as { nextCursor: string }).nextCursor;
    const replayed = await gql(
      app,
      `{ findingsConnection(limit: 1, cursor: "${cursor}", filter: { releasedOnly: true }) { items { id } } }`,
      ANALYST,
    );
    expect(replayed.errors?.[0]?.extensions).toMatchObject({ code: 'invalid_cursor' });
    const tooBig = await gql(app, '{ findingsConnection(limit: 201) { items { id } } }', ANALYST);
    expect(tooBig.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
  });
});
