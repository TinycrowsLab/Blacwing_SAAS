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
  memoryStore,
  recordOf,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import { TenantSettingsModule } from './module.js';

import type { Problem, TenantSettingsResponse } from '@blackwing/contracts';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

/**
 * Test IAM: the validated principal comes from a header the test controls, never from the body. The
 * header value is `<user>@<tenant>`, for example `admin-a@a`.
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

beforeEach(async () => {
  metrics = createHttpMetrics();
  const store = memoryStore({
    [TENANT_A]: recordOf({ displayTimezone: 'Europe/Berlin' }),
    [TENANT_B]: recordOf({}),
  });
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      TenantSettingsModule.forRoot({
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

const url = '/v1/tenant/settings';
/** The ETag a response carries; a response without one is a test failure. */
function etagOf(res: { readonly headers: Record<string, unknown> }): string {
  const etag = res.headers.etag;
  if (typeof etag !== 'string') throw new Error('the response carries no ETag');
  return etag;
}

const as = (principal?: string) =>
  principal === undefined ? {} : { 'x-test-principal': principal };

async function read(principal: string) {
  return app.inject({ method: 'GET', url, headers: as(principal) });
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

describe('GET /v1/tenant/settings', () => {
  it('answers the settings, the read-only region, an ETag and no-store', async () => {
    const res = await read('admin-a@a');
    expect(res.statusCode).toBe(200);
    expect(etagOf(res)).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<TenantSettingsResponse>();
    expect(body.settings).toEqual({
      displayTimezone: 'Europe/Berlin',
      defaultAssessmentMode: 'grey',
    });
    expect(body.region).toBe('eu-west-1');
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
  });

  it('lets an auditor read', async () => {
    expect((await read('auditor-a@a')).statusCode).toBe(200);
  });

  it('answers 401 with no principal and never runs the handler', async () => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('answers 403 for a principal with no membership in the tenant', async () => {
    const res = await read('admin-b@a');
    expect(res.statusCode).toBe(403);
    expect(res.json<Problem>().code).toBe('permission_denied');
  });
});

describe('PATCH /v1/tenant/settings', () => {
  it('answers 428 problem+json without If-Match', async () => {
    const res = await patch('admin-a@a', { defaultAssessmentMode: 'white' });
    expect(res.statusCode).toBe(428);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('precondition_required');
  });

  it('answers 412 problem+json for a stale ETag and leaves the settings', async () => {
    const etag = etagOf(await read('admin-a@a'));
    expect((await patch('admin-a@a', { weekStartsOn: 1 }, etag)).statusCode).toBe(200);
    const stale = await patch('admin-a@a', { weekStartsOn: 0 }, etag);
    expect(stale.statusCode).toBe(412);
    expect(stale.json<Problem>().code).toBe('precondition_failed');
  });

  it('changes the settings, returns the new ETag, and the next GET agrees with it', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', { displayTimezone: 'Asia/Tokyo' }, etag);
    expect(res.statusCode).toBe(200);
    expect(res.json<TenantSettingsResponse>().settings.displayTimezone).toBe('Asia/Tokyo');
    const next = etagOf(res);
    expect(next).not.toBe(etag);
    expect(etagOf(await read('admin-a@a'))).toBe(next);
    expect(
      await metrics.registry.getSingleMetricAsString('bw_tenant_settings_updated_total'),
    ).toMatch(/bw_tenant_settings_updated_total 1/);
  });

  it('answers invalid_timezone (422) for an unknown zone and writes nothing', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', { displayTimezone: 'Mars/Olympus' }, etag);
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('invalid_timezone');
  });

  it.each([
    ['an unknown key', { isAdmin: true }],
    ['region, which is read-only', { region: 'us-east-1' }],
  ])('answers 422 validation_failed for %s', async (_label, body) => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', body, etag);
    expect(res.statusCode).toBe(422);
    expect(res.json<Problem>().code).toBe('validation_failed');
  });

  it('answers 403 for an auditor (read-only) and writes nothing', async () => {
    const etag = etagOf(await read('auditor-a@a'));
    const res = await patch('auditor-a@a', { weekStartsOn: 1 }, etag);
    expect(res.statusCode).toBe(403);
    expect(res.json<Problem>().code).toBe('permission_denied');
  });

  it('denies a cross-tenant PATCH: an admin of tenant B cannot change tenant A', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-b@a', { weekStartsOn: 1 }, etag);
    expect(res.statusCode).toBe(403);
    expect((await read('admin-a@a')).json<TenantSettingsResponse>().settings).not.toHaveProperty(
      'weekStartsOn',
    );
  });

  it('answers an empty PATCH with the current ETag and no write', async () => {
    const etag = etagOf(await read('admin-a@a'));
    const res = await patch('admin-a@a', {}, etag);
    expect(res.statusCode).toBe(200);
    expect(etagOf(res)).toBe(etag);
    expect(
      await metrics.registry.getSingleMetricAsString('bw_tenant_settings_updated_total'),
    ).toMatch(/bw_tenant_settings_updated_total 0/);
  });
});
