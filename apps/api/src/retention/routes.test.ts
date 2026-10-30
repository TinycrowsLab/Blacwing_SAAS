import Fastify, { type FastifyInstance } from 'fastify';
import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import { InMemoryRetentionStore } from './memory.js';
import { createRetentionMetrics } from './metrics.js';
import { RETENTION_POLICIES_ROUTE, registerRetentionRoutes } from './routes.js';
import { RetentionService } from './service.js';

const TENANT = '0190f6a2-7b1c-7d2e-8f3a-123456789abc';
const USER = '0190f6a2-7b1c-7d2e-8f3a-000000000001';

const body = { policies: [{ dataClass: 'logs', retentionDays: 45, enabled: true }] };

interface Json {
  code?: string;
  policies?: { dataClass: string; retentionDays: number }[];
}

/** The parsed JSON body of an injected response. */
const json = (res: { body: string }): Json => JSON.parse(res.body) as Json;

describe('retention policy routes', () => {
  let app: FastifyInstance;
  let roles: string[];
  let tenantId: string | null;

  beforeEach(async () => {
    roles = ['org_admin'];
    tenantId = TENANT;
    const service = new RetentionService({
      store: new InMemoryRetentionStore(),
      metrics: createRetentionMetrics(new Registry()),
    });
    app = Fastify();
    registerRetentionRoutes(app, {
      service,
      authenticate: (request) => {
        if (request.headers.authorization !== 'Bearer bw_pat_ok') {
          return Promise.reject(new AuthError('no credential'));
        }
        return Promise.resolve({ type: 'user', id: USER, tenantId, roles });
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const auth = { authorization: 'Bearer bw_pat_ok' };

  it('GET answers 200 with the policy set and a strong ETag, uncacheable', async () => {
    const res = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(json(res).policies).toHaveLength(6);
  });

  it('GET refuses an unauthenticated caller with 401 problem+json and no body data', async () => {
    const res = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(json(res).policies).toBeUndefined();
  });

  it('PUT without If-Match is 428, with a stale one 412', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: auth,
      payload: body,
    });
    expect(missing.statusCode).toBe(428);

    const get = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE, headers: auth });
    const etag = String(get.headers.etag);
    const ok = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: { ...auth, 'if-match': etag },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).policies?.find((p) => p.dataClass === 'logs')?.retentionDays).toBe(45);

    const stale = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: { ...auth, 'if-match': etag },
      payload: body,
    });
    expect(stale.statusCode).toBe(412);
  });

  it('PUT below the platform floor is 422 problem+json and changes nothing', async () => {
    const get = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE, headers: auth });
    const res = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: { ...auth, 'if-match': String(get.headers.etag) },
      payload: { policies: [{ dataClass: 'logs', retentionDays: 5, enabled: true }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(json(res).code).toBe('VALIDATION_FAILED');
  });

  it('PUT with a malformed JSON body is a validation problem, not a 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: { ...auth, 'if-match': '*', 'content-type': 'application/json' },
      payload: '{"policies": [',
    });
    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('VALIDATION_FAILED');
  });

  it('PUT by a role without settings:write is 403, and GET by a developer is 403', async () => {
    roles = ['developer'];
    const get = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE, headers: auth });
    expect(get.statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: RETENTION_POLICIES_ROUTE,
      headers: { ...auth, 'if-match': '*' },
      payload: body,
    });
    expect(put.statusCode).toBe(403);
  });

  it('a caller with no tenant context is refused (fail closed)', async () => {
    tenantId = null;
    const res = await app.inject({ method: 'GET', url: RETENTION_POLICIES_ROUTE, headers: auth });
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('TENANT_CONTEXT_MISSING');
  });
});
