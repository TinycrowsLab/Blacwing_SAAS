import { afterEach, describe, expect, it, vi } from 'vitest';

import { toPublicId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { GraphqlApiModule } from './module.js';
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
  memoryFindingStore,
  memoryMemberships,
  occurrenceRow,
  uuidOf,
} from '../findings/fixtures.test-helpers.js';
import { createCedarFindingPolicy } from '../findings/policy.js';
import { FindingService } from '../findings/service.js';
import { createCursorCodec } from '../pagination/index.js';

import type { AssessmentReadStore, SurfaceReadStore } from './store.js';
import type { FindingStore } from '../findings/ports.js';
import type { FindingRow } from '@blackwing/db';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';

const CURSOR_SECRET = 'g'.repeat(40);

function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant, user] = header.split(':');
  if (kind !== 'session' || tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

/** This suite never reads the assessment requests or the surface. */
const NO_ASSESSMENTS: AssessmentReadStore = {
  rolesOf: () => Promise.resolve([]),
  listRequests: () => Promise.resolve([]),
  findRequest: () => Promise.resolve(undefined),
};
const NO_SURFACE: SurfaceReadStore = {
  rolesOf: () => Promise.resolve([]),
  summariesOf: () => Promise.resolve(new Map()),
  endpointsOf: () => Promise.resolve(undefined),
};

/** Tenant A: confirmed findings 1..4 (finding 1 has two occurrences), suspected finding 5. Tenant B: one finding. */
function rows(): FindingRow[] {
  return [
    findingRow(1),
    findingRow(2),
    findingRow(3),
    findingRow(4),
    findingRow(5, { status: 'suspected' }),
    findingRow(6, { tenantId: TENANT_B }),
  ];
}

const occurrences = [
  occurrenceRow(1, 1),
  occurrenceRow(1, 2),
  occurrenceRow(2, 1, { evidenceChainHead: null }),
];

let current: ApiApp | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

/** Boots the API with the GraphQL module, a finding service over the in-memory store, and counts the store reads. */
async function boot(
  options: { readonly withFindings?: boolean; readonly store?: FindingStore } = {},
) {
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  const base = memoryFindingStore(rows(), occurrences, () => tenantIdOf());
  const store: FindingStore = options.store ?? base;
  const service = new FindingService({
    store,
    memberships: memoryMemberships({
      [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [DEV_A]: ['developer'] },
      [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
    }),
    policy: createCedarFindingPolicy(),
    cursors: createCursorCodec(CURSOR_SECRET),
    metrics: { request: vi.fn() },
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
        assessments: NO_ASSESSMENTS,
        surface: NO_SURFACE,
        ...(options.withFindings === false ? {} : { findings: service }),
      }),
    ],
  });
  await app.app.getHttpAdapter().getInstance().ready();
  current = app;
  return { app, store };
}

/** The tenant of the request under test; the store reads the ambient tenant, as the RLS context would. */
const tenantIdOf = (): string => TENANT_A;

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { message: string; extensions: { code: string } }[];
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

const DEV = `session:${TENANT_A}:${DEV_A}`;
const APPSEC = `session:${TENANT_A}:${APPSEC_A}`;
const NOROLE = `session:${TENANT_A}:${NOROLE_A}`;
const APPSEC_OTHER = `session:${TENANT_B}:${APPSEC_B}`;

const LIST = `{
  findings(first: 50) { hasMore nextCursor items { id title status } }
}`;

describe('GraphQL findings', () => {
  it('lists the tenant findings to a developer, without the suspected one', async () => {
    const { app } = await boot();
    const body = await gql(app, LIST, DEV);
    expect(body.errors).toBeUndefined();
    const data = body.data as { findings: { items: { status: string }[]; hasMore: boolean } };
    expect(data.findings.items).toHaveLength(4);
    expect(data.findings.items.map((i) => i.status)).not.toContain('suspected');
    expect(data.findings.hasMore).toBe(false);
  });

  it('shows the suspected finding to an analyst', async () => {
    const { app } = await boot();
    const body = await gql(
      app,
      `{ findings(filter: { status: "suspected" }) { items { id status } } }`,
      APPSEC,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      findings: { items: [{ id: findingRow(5).publicId, status: 'suspected' }] },
    });
  });

  it('pages with the REST cursor, first and after', async () => {
    const { app } = await boot();
    const first = await gql(app, `{ findings(first: 2) { hasMore nextCursor items { id } } }`, DEV);
    const page1 = first.data as {
      findings: { hasMore: boolean; nextCursor: string; items: { id: string }[] };
    };
    expect(page1.findings.items).toHaveLength(2);
    expect(page1.findings.hasMore).toBe(true);
    const second = await gql(
      app,
      `{ findings(first: 2, after: "${page1.findings.nextCursor}") { items { id } } }`,
      DEV,
    );
    const page2 = second.data as { findings: { items: { id: string }[] } };
    const ids = [...page1.findings.items, ...page2.findings.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('refuses an unknown filter field at the schema, and an unusable filter value as invalid_filter', async () => {
    const { app } = await boot();
    const unknownField = await gql(
      app,
      `{ findings(filter: { severty: "high" }) { items { id } } }`,
      DEV,
    );
    expect(unknownField.errors?.[0]?.extensions.code).toBe('validation_failed');
    const badValue = await gql(
      app,
      `{ findings(filter: { status: "nonsense" }) { items { id } } }`,
      DEV,
    );
    expect(badValue.errors?.[0]?.extensions.code).toBe('invalid_filter');
    const badCwe = await gql(
      app,
      `{ findings(filter: { cwe: "CWE-99999" }) { items { id } } }`,
      DEV,
    );
    expect(badCwe.errors?.[0]?.extensions.code).toBe('invalid_filter');
  });

  it('refuses a caller with no role with permission_denied', async () => {
    const { app } = await boot();
    const body = await gql(app, LIST, NOROLE);
    expect(body.errors?.[0]?.extensions.code).toBe('permission_denied');
  });

  it('answers the detail with occurrences and evidence through the batched loader', async () => {
    const { app } = await boot();
    const id = findingRow(1).publicId;
    const body = await gql(
      app,
      `{ finding(id: "${id}") { id cweId owaspCategory occurrences(first: 10) { total truncated items { id occurrenceStatus } } evidence { total items { sha256 } } } }`,
      DEV,
    );
    expect(body.errors).toBeUndefined();
    const finding = (body.data as { finding: Record<string, unknown> }).finding;
    expect(finding.id).toBe(id);
    expect(finding.cweId).toBe('CWE-285');
    expect(finding.occurrences).toMatchObject({ total: 2, truncated: false });
    expect(finding.evidence).toMatchObject({ total: 2 });
  });

  it('batches the occurrences of every finding in one page into one store read (DataLoader)', async () => {
    const counting = memoryFindingStore(rows(), occurrences, () => tenantIdOf());
    const listOccurrencesOf = vi.fn(counting.listOccurrencesOf.bind(counting));
    const store: FindingStore = { ...counting, listOccurrencesOf };
    const { app } = await boot({ store });
    const body = await gql(
      app,
      `{ findings(first: 50) { items { id occurrences(first: 5) { total } } } }`,
      DEV,
    );
    expect(body.errors).toBeUndefined();
    expect(listOccurrencesOf).toHaveBeenCalledTimes(1);
    expect(listOccurrencesOf.mock.calls[0]?.[0]).toHaveLength(4);
  });

  it('answers null for a suspected finding to a developer, as for a missing one (no existence leak)', async () => {
    const { app } = await boot();
    const hidden = await gql(app, `{ finding(id: "${findingRow(5).publicId}") { id } }`, DEV);
    const missing = await gql(
      app,
      `{ finding(id: "${toPublicId(uuidOf(0x7777), 'fnd')}") { id } }`,
      DEV,
    );
    expect(hidden.errors).toBeUndefined();
    expect(hidden.data).toEqual({ finding: null });
    expect(missing.data).toEqual({ finding: null });
  });

  it('answers null for another tenant finding (cross-tenant negative)', async () => {
    const { app } = await boot();
    const body = await gql(app, `{ finding(id: "${findingRow(6).publicId}") { id } }`, DEV);
    expect(body.data).toEqual({ finding: null });
    const reverse = await gql(
      app,
      `{ finding(id: "${findingRow(1).publicId}") { id } }`,
      APPSEC_OTHER,
    );
    expect(reverse.data).toEqual({ finding: null });
  });

  it('fails closed when the finding service is not configured', async () => {
    const { app } = await boot({ withFindings: false });
    const body = await gql(app, LIST, DEV);
    expect(body.errors?.[0]?.extensions.code).toBe('graph_query_unavailable');
  });
});
