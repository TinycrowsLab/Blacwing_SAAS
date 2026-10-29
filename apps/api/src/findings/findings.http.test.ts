import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTenantContextOrThrow, type TenantPrincipal } from '@blackwing/db/tenant-context';
import { toPublicId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import {
  APPSEC_A,
  APPSEC_B,
  AUDITOR_A,
  DEV_A,
  NOROLE_A,
  TENANT_A,
  TENANT_B,
  findingRow,
  memoryFindingStore,
  memoryMemberships,
  occurrenceRow,
  uuidOf,
} from './fixtures.test-helpers.js';
import { FindingModule } from './module.js';
import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const USERS: Record<string, string> = {
  'appsec-a': APPSEC_A,
  'dev-a': DEV_A,
  'norole-a': NOROLE_A,
  'appsec-b': APPSEC_B,
  'auditor-a': AUDITOR_A,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };
const CURSOR_SECRET = 'c'.repeat(40);

/** Test IAM: the principal comes from a header the test controls, as `<user>@<tenant>` (for example `dev-a@a`). */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

let app: NestFastifyApplication;
let metrics: HttpMetrics;
let suspected: ReturnType<typeof findingRow>;
let confirmedA: ReturnType<typeof findingRow>;
let foreign: ReturnType<typeof findingRow>;

beforeEach(async () => {
  metrics = createHttpMetrics();
  // Tenant A: five confirmed findings and one suspected one. Tenant B: one confirmed finding of its own.
  const rows = [1, 2, 3, 4, 5].map((n) => findingRow(n));
  suspected = findingRow(6, { status: 'suspected' });
  confirmedA = nth(rows, 0);
  foreign = findingRow(7, { tenantId: TENANT_B, assetId: uuidOf(0xb1) });
  const store = memoryFindingStore(
    [...rows, suspected, foreign],
    [occurrenceRow(1, 1), occurrenceRow(1, 2)],
    () => getTenantContextOrThrow().tenantId,
  );
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      FindingModule.forRoot({
        store,
        memberships: memoryMemberships({
          [TENANT_A]: {
            [APPSEC_A]: ['appsec_engineer'],
            [DEV_A]: ['developer'],
            [AUDITOR_A]: ['auditor'],
          },
          [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
        }),
        logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
        registry: metrics.registry,
        cursorSecret: CURSOR_SECRET,
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const url = '/v1/findings';

/** The element at `index`, which the fixture knows is there. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no fixture at index ${String(index)}`);
  return item;
}
const as = (who: string) => ({ 'x-test-principal': who });

interface ListBody {
  readonly items: { readonly id: string }[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** One `GET /v1/findings` call as the walk reads it: the status and the parsed page. */
async function listPage(qs: string): Promise<{ status: number; body: ListBody }> {
  const res = await app.inject({ method: 'GET', url: `${url}?${qs}`, headers: as('dev-a@a') });
  return { status: res.statusCode, body: res.json<ListBody>() };
}

interface ProblemBody {
  readonly status: number;
  readonly code: string;
}

describe('GET /v1/findings', () => {
  it('lists the tenant findings to a developer, newest first, and never a suspected one', async () => {
    const res = await app.inject({ method: 'GET', url, headers: as('dev-a@a') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ items: { status: string; id: string }[]; hasMore: boolean }>();
    expect(body.items.map((item) => item.status)).not.toContain('suspected');
    expect(body.items).toHaveLength(5);
    expect(body.items[0]?.id).toBe(toPublicId(findingRow(5).id, 'fnd'));
    expect(body.hasMore).toBe(false);
  });

  it('lets an analyst see the suspected finding, filtered by status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}?status=suspected`,
      headers: as('appsec-a@a'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([
      suspected.publicId,
    ]);
  });

  it('answers an empty page for a developer who filters on suspected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}?status=suspected`,
      headers: as('dev-a@a'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it('pages with cursors: each page is limited, and the walk covers every visible finding once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const qs = `limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page = await listPage(qs);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((item) => item.id));
      cursor = page.body.nextCursor;
      if (!page.body.hasMore) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('answers 400 invalid_cursor for a tampered cursor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}?cursor=forged.token`,
      headers: as('dev-a@a'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ProblemBody>().code).toBe('invalid_cursor');
  });

  it('answers 400 bad_request for a malformed limit', async () => {
    for (const limit of ['0', '-1', 'abc', '1.5']) {
      const res = await app.inject({
        method: 'GET',
        url: `${url}?limit=${limit}`,
        headers: as('dev-a@a'),
      });
      expect(res.statusCode, `limit=${limit}`).toBe(400);
      expect(res.json<ProblemBody>().code).toBe('bad_request');
    }
  });

  it('answers 400 invalid_filter for an unknown filter, status, CWE or OWASP id', async () => {
    for (const q of ['severty=high', 'status=nonsense', 'cwe=CWE-99999', 'owasp=A11']) {
      const res = await app.inject({ method: 'GET', url: `${url}?${q}`, headers: as('dev-a@a') });
      expect(res.statusCode, q).toBe(400);
      expect(res.json<ProblemBody>().code).toBe('invalid_filter');
    }
  });

  it('is tenant scoped: tenant B sees only its own finding, never tenant A findings', async () => {
    const res = await app.inject({ method: 'GET', url, headers: as('appsec-b@b') });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([
      foreign.publicId,
    ]);
  });

  it('refuses a member with no role in the tenant with 403 permission_denied', async () => {
    const res = await app.inject({ method: 'GET', url, headers: as('norole-a@a') });
    expect(res.statusCode).toBe(403);
    expect(res.json<ProblemBody>().code).toBe('permission_denied');
  });

  it('refuses an unauthenticated caller (no principal)', async () => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/findings/:id', () => {
  it('returns the detail with occurrences, mapping and evidence refs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${confirmedA.publicId}`,
      headers: as('dev-a@a'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      id: string;
      cweId: string;
      owaspCategory: string;
      baselineStatus: string;
      occurrences: { items: unknown[]; total: number };
      evidence: { items: unknown[]; total: number };
    }>();
    expect(body.id).toBe(confirmedA.publicId);
    expect(body.cweId).toBe('CWE-285');
    expect(body.owaspCategory).toBe('A01');
    expect(body.baselineStatus).toBe('new');
    expect(body.occurrences.total).toBe(2);
    expect(body.evidence.total).toBe(2);
  });

  it('answers 404 for a suspected finding to a developer, as for a missing one', async () => {
    const hidden = await app.inject({
      method: 'GET',
      url: `${url}/${suspected.publicId}`,
      headers: as('dev-a@a'),
    });
    const missing = await app.inject({
      method: 'GET',
      url: `${url}/${toPublicId(uuidOf(0x7777), 'fnd')}`,
      headers: as('dev-a@a'),
    });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.json<ProblemBody>().code).toBe(missing.json<ProblemBody>().code);
  });

  it('answers the analyst the suspected finding', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${suspected.publicId}`,
      headers: as('appsec-a@a'),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers 404 for another tenant finding (cross-tenant negative, RLS plus Cedar)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${foreign.publicId}`,
      headers: as('dev-a@a'),
    });
    expect(res.statusCode).toBe(404);
    const reverse = await app.inject({
      method: 'GET',
      url: `${url}/${confirmedA.publicId}`,
      headers: as('appsec-b@b'),
    });
    expect(reverse.statusCode).toBe(404);
  });

  it('answers 404 for a malformed id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/not-an-id`,
      headers: as('dev-a@a'),
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a member with no role with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${confirmedA.publicId}`,
      headers: as('norole-a@a'),
    });
    expect(res.statusCode).toBe(403);
  });
});
