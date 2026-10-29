import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  ADMIN_A,
  ADMIN_B,
  APPSEC2_A,
  APPSEC_A,
  ASSET_A_UNVERIFIED,
  ASSET_A1,
  AUDITOR_A,
  draftBody,
  memoryStore,
  standardFixtures,
  TENANT_A,
  TENANT_B,
  testCursors,
} from './fixtures.test-helpers.js';
import { AuthorisationModule } from './module.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';

import type { Problem, StandingAuthorisationDto } from '@blackwing/contracts';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/** Test IAM: the principal comes from a header the test controls. The value is `<user>@<tenant>`. */
const USERS: Record<string, string> = {
  'admin-a': ADMIN_A,
  'appsec-a': APPSEC_A,
  'appsec2-a': APPSEC2_A,
  'auditor-a': AUDITOR_A,
  'admin-b': ADMIN_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

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
let store: ReturnType<typeof memoryStore>;

beforeEach(async () => {
  metrics = createHttpMetrics();
  store = memoryStore();
  const fixtures = standardFixtures();
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    idempotencyStore: new InMemoryIdempotencyStore(),
    imports: [
      AuthorisationModule.forRoot({
        store,
        assets: fixtures.assets,
        memberships: fixtures.memberships,
        cursors: testCursors(),
        logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
        registry: metrics.registry,
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const BASE = '/v1/standing-authorisations';
const as = (principal?: string) =>
  principal === undefined ? {} : { 'x-test-principal': principal };

async function create(
  principal: string,
  body: unknown = draftBody(),
  key = `key-${Math.random()}`,
) {
  return app.inject({
    method: 'POST',
    url: BASE,
    headers: { ...as(principal), 'content-type': 'application/json', 'idempotency-key': key },
    payload: body as Record<string, unknown>,
  });
}

async function patch(
  principal: string,
  id: string,
  body: Record<string, unknown>,
  ifMatch?: string,
) {
  return app.inject({
    method: 'PATCH',
    url: `${BASE}/${id}`,
    headers: {
      ...as(principal),
      'content-type': 'application/json',
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    payload: body,
  });
}

async function submit(principal: string, id: string, ifMatch?: string) {
  return app.inject({
    method: 'POST',
    url: `${BASE}/${id}/submit`,
    headers: { ...as(principal), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
  });
}

function etagOf(res: { readonly headers: Record<string, unknown> }): string {
  const etag = res.headers.etag;
  if (typeof etag !== 'string') throw new Error('the response carries no ETag');
  return etag;
}

describe('POST /v1/standing-authorisations', () => {
  it('creates a draft: 201, an ETag, no-store, and the sa_ public id', async () => {
    const res = await create('appsec-a@a');
    expect(res.statusCode).toBe(201);
    expect(etagOf(res)).toBe('"v1"');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<StandingAuthorisationDto>();
    expect(body).toMatchObject({ status: 'draft', version: 1, requesterId: APPSEC_A });
    expect(body.id).toMatch(/^sa_[0-9a-z]+$/);
  });

  it('replays the same Idempotency-Key with the original resource, and creates no duplicate', async () => {
    const first = await create('appsec-a@a', draftBody(), 'same-key');
    const replay = await create('appsec-a@a', draftBody(), 'same-key');
    expect(replay.statusCode).toBe(201);
    expect(replay.json<StandingAuthorisationDto>().id).toBe(
      first.json<StandingAuthorisationDto>().id,
    );
    expect(store.rows.size).toBe(1);
  });

  it('refuses a reused Idempotency-Key with a different body (409), and a missing key (400)', async () => {
    await create('appsec-a@a', draftBody(), 'reuse-key-1');
    const reused = await create(
      'appsec-a@a',
      draftBody({ maxIntrusiveness: 'passive' }),
      'reuse-key-1',
    );
    expect(reused.statusCode).toBe(409);
    expect(reused.json<Problem>().code).toBe('idempotency_conflict');
    const missing = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { ...as('appsec-a@a'), 'content-type': 'application/json' },
      payload: draftBody(),
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<Problem>().code).toBe('idempotency_key_required');
  });

  it('refuses an unknown field and a destructive ceiling with 422 problem+json pointers', async () => {
    const extra = await create('appsec-a@a', { ...draftBody(), tenantId: TENANT_B });
    expect(extra.statusCode).toBe(422);
    expect(extra.headers['content-type']).toContain('application/problem+json');
    const destructive = await create(
      'appsec-a@a',
      draftBody({ maxIntrusiveness: 'destructive' as never }),
    );
    expect(destructive.statusCode).toBe(422);
    expect(store.rows.size).toBe(0);
  });

  it('answers 401 with no principal, and 403 for a reader who may not create', async () => {
    const anonymous = await app.inject({
      method: 'POST',
      url: BASE,
      headers: { 'idempotency-key': 'k-anon' },
      payload: draftBody(),
    });
    expect(anonymous.statusCode).toBe(401);
    const auditor = await create('auditor-a@a');
    expect(auditor.statusCode).toBe(403);
    expect(auditor.json<Problem>().code).toBe('permission_denied');
    // An org admin reads standing authorisations but holds no sa:create (RBAC-001).
    expect((await create('admin-a@a')).statusCode).toBe(403);
  });
});

describe('draft -> patch -> submit (AUTHZ-002 happy path)', () => {
  it('walks the lifecycle with ETags and ends in pending_approval', async () => {
    const created = await create('appsec-a@a');
    const id = created.json<StandingAuthorisationDto>().id;
    const changed = await patch('appsec-a@a', id, { maxIntrusiveness: 'passive' }, etagOf(created));
    expect(changed.statusCode).toBe(200);
    expect(changed.json<StandingAuthorisationDto>()).toMatchObject({
      maxIntrusiveness: 'passive',
      version: 2,
    });
    const submitted = await submit('appsec-a@a', id, etagOf(changed));
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<StandingAuthorisationDto>()).toMatchObject({
      status: 'pending_approval',
      version: 3,
    });
    const read = await app.inject({
      method: 'GET',
      url: `${BASE}/${id}`,
      headers: as('auditor-a@a'),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<StandingAuthorisationDto>().status).toBe('pending_approval');
  });

  it('answers 428 without If-Match, 412 for a stale one, and 409 for a change after submit', async () => {
    const created = await create('appsec-a@a');
    const id = created.json<StandingAuthorisationDto>().id;
    expect((await patch('appsec-a@a', id, { maxIntrusiveness: 'passive' })).statusCode).toBe(428);
    expect(
      (await patch('appsec-a@a', id, { maxIntrusiveness: 'passive' }, '"v7"')).statusCode,
    ).toBe(412);
    const submitted = await submit('appsec-a@a', id, etagOf(created));
    expect(submitted.statusCode).toBe(200);
    const late = await patch('appsec-a@a', id, { maxIntrusiveness: 'passive' }, etagOf(submitted));
    expect(late.statusCode).toBe(409);
    expect(late.json<Problem>().code).toBe('AUTHZ_NOT_DRAFT'.toLowerCase());
  });

  it('refuses a submit that covers an unverified asset with 422 and keeps the draft', async () => {
    const created = await create(
      'appsec-a@a',
      draftBody({ assetIds: [ASSET_A1, ASSET_A_UNVERIFIED] }),
    );
    const id = created.json<StandingAuthorisationDto>().id;
    const res = await submit('appsec-a@a', id, etagOf(created));
    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('authz_asset_unverified');
    const read = await app.inject({
      method: 'GET',
      url: `${BASE}/${id}`,
      headers: as('appsec-a@a'),
    });
    expect(read.json<StandingAuthorisationDto>().status).toBe('draft');
  });

  it("hides another tenant's draft (404) and refuses a patch that is empty (422)", async () => {
    const created = await create('appsec-a@a');
    const id = created.json<StandingAuthorisationDto>().id;
    const foreign = await app.inject({
      method: 'GET',
      url: `${BASE}/${id}`,
      headers: as('admin-b@b'),
    });
    expect(foreign.statusCode).toBe(404);
    const empty = await patch('appsec-a@a', id, {}, etagOf(created));
    expect(empty.statusCode).toBe(422);
  });

  it('refuses a patch by the appsec engineer who did not request the draft (403)', async () => {
    const created = await create('appsec-a@a');
    const id = created.json<StandingAuthorisationDto>().id;
    const res = await patch('appsec2-a@a', id, { maxIntrusiveness: 'passive' }, etagOf(created));
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/standing-authorisations (list)', () => {
  it('pages with nextCursor and answers the tenant only', async () => {
    await create('appsec-a@a');
    await create('appsec-a@a');
    await create('appsec-a@a');
    const first = await app.inject({
      method: 'GET',
      url: `${BASE}?limit=2`,
      headers: as('appsec-a@a'),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }>();
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const second = await app.inject({
      method: 'GET',
      url: `${BASE}?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
      headers: as('appsec-a@a'),
    });
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    const other = await app.inject({ method: 'GET', url: BASE, headers: as('admin-b@b') });
    expect(other.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('refuses a malformed limit with 422', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${BASE}?limit=abc`,
      headers: as('appsec-a@a'),
    });
    expect(res.statusCode).toBe(422);
  });
});
