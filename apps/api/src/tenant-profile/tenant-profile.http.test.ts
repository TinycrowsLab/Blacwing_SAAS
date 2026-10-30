import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  ADMIN_A,
  ADMIN_B,
  AUDITOR_A,
  memoryMemberships,
  memoryProfileStore,
  profileOf,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { TenantProfileModule } from './module.js';

import type { OrgProfile, Problem } from '@blackwing/contracts';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * Test IAM: the validated principal comes from a header the test controls, never from the body. The header
 * value is `<user>@<tenant>`, for example `admin-a@a`.
 */
const USERS: Record<string, string> = {
  'admin-a': ADMIN_A,
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
let store: ReturnType<typeof memoryProfileStore>;

beforeEach(async () => {
  metrics = createHttpMetrics();
  store = memoryProfileStore({
    [TENANT_A]: profileOf({}, { displayTimezone: 'Europe/Berlin' }),
    [TENANT_B]: profileOf({ name: 'Other tenant' }),
  });
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      TenantProfileModule.forRoot({
        store,
        memberships: memoryMemberships({
          [TENANT_A]: { [ADMIN_A]: ['org_admin'], [AUDITOR_A]: ['auditor'] },
          [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
        }),
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

const url = '/v1/tenants/current';

function etagOf(res: { readonly headers: Record<string, unknown> }): string {
  const etag = res.headers.etag;
  if (typeof etag !== 'string') throw new Error('the response carries no ETag');
  return etag;
}

const as = (principal?: string) =>
  principal === undefined ? {} : { 'x-test-principal': principal };

async function read(principal: string, query = '') {
  return app.inject({ method: 'GET', url: `${url}${query}`, headers: as(principal) });
}

async function patch(principal: string, body: Record<string, unknown>, ifMatch?: string) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: {
      ...as(principal),
      'content-type': 'application/json',
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    payload: body,
  });
}

describe('GET /v1/tenants/current', () => {
  it('answers the caller tenant profile with an ETag and no-store', async () => {
    const res = await read('admin-a@a');
    expect(res.statusCode).toBe(200);
    expect(etagOf(res)).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<OrgProfile>();
    expect(body).toMatchObject({
      name: 'Acme Security',
      slug: 'acme',
      region: 'eu-west-1',
      defaultTimezone: 'Europe/Berlin',
      supportContactEmail: null,
    });
  });

  it('ignores a tenant id forged in the query: the tenant comes from the principal only', async () => {
    const res = await read('admin-a@a', `?tenantId=${TENANT_B}`);
    expect(res.json<OrgProfile>().name).toBe('Acme Security');
  });

  it('answers 401 with no principal', async () => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
  });

  it('answers 403 forbidden_role for an auditor, who may not read the admin profile', async () => {
    const res = await read('auditor-a@a');
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('forbidden_role');
  });
});

describe('PATCH /v1/tenants/current', () => {
  it('answers 428 without If-Match and never runs the change', async () => {
    const res = await patch('admin-a@a', { name: 'Late' });
    expect(res.statusCode).toBe(428);
    expect(res.json<Problem>().code).toBe('precondition_required');
    expect(store.mutations.count).toBe(0);
  });

  it('renames the organisation, returns the new ETag, and the next GET agrees with it', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', { name: 'Acme Security Ltd' }, etag);
    expect(res.statusCode).toBe(200);
    expect(res.json<OrgProfile>().name).toBe('Acme Security Ltd');
    const next = etagOf(res);
    expect(next).not.toBe(etag);
    expect(etagOf(await read('admin-a@a'))).toBe(next);
    expect(store.audits).toHaveLength(1);
    expect(await metrics.registry.getSingleMetricAsString('bw_settings_save_total')).toMatch(
      /bw_settings_save_total\{section="org",result="ok"\} 1/,
    );
  });

  it('answers 409-class ETAG_MISMATCH as etag_mismatch (412) for a stale ETag and leaves the profile', async () => {
    const etag = etagOf(await read('admin-a@a'));
    expect((await patch('admin-a@a', { name: 'First' }, etag)).statusCode).toBe(200);
    const stale = await patch('admin-a@a', { name: 'Second' }, etag);
    expect(stale.statusCode).toBe(412);
    expect(stale.headers['content-type']).toContain('application/problem+json');
    expect(stale.json<Problem>().code).toBe('etag_mismatch');
    expect((await read('admin-a@a')).json<OrgProfile>().name).toBe('First');
  });

  it('sets the display zone and the support contact, and returns them redacted nowhere but the response', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch(
      'admin-a@a',
      { defaultTimezone: 'Asia/Tokyo', supportContactEmail: 'soc@acme.test' },
      etag,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<OrgProfile>()).toMatchObject({
      defaultTimezone: 'Asia/Tokyo',
      supportContactEmail: 'soc@acme.test',
    });
    expect(JSON.stringify(store.audits)).not.toContain('soc@acme.test');
  });

  it.each([
    ['an unknown time zone', { defaultTimezone: 'Mars/Olympus' }],
    ['a read-only slug', { slug: 'other' }],
    ['a read-only region', { region: 'us-east-1' }],
    ['a tenant id in the body', { tenantId: TENANT_B }],
    ['an empty name', { name: '' }],
  ])('answers 422 validation_failed for %s and writes nothing', async (_label, body) => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', body, etag);
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('validation_failed');
    expect(store.mutations.count).toBe(0);
  });

  it('answers 403 forbidden_role for an auditor and writes nothing', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('auditor-a@a', { name: 'Nope' }, etag);
    expect(res.statusCode).toBe(403);
    expect(res.json<Problem>().code).toBe('forbidden_role');
    expect(store.rows.get(TENANT_A)?.name).toBe('Acme Security');
  });

  it('denies a cross-tenant PATCH: an admin of tenant B cannot change tenant A', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-b@a', { name: 'Hijack' }, etag);
    expect(res.statusCode).toBe(403);
    expect(store.rows.get(TENANT_A)?.name).toBe('Acme Security');
    expect(store.rows.get(TENANT_B)?.name).toBe('Other tenant');
  });

  it('answers an empty PATCH with the current ETag and no write', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', {}, etag);
    expect(res.statusCode).toBe(200);
    expect(etagOf(res)).toBe(etag);
    expect(store.audits).toEqual([]);
  });
});
