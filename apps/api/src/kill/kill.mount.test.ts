import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { harness, type Harness, LIVE_RUN, principal, TENANT_A } from './fixtures.test-helpers.js';
import { registerKillRoutes } from './routes.js';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const ADMIN = principal(['org_admin']);

// The kill routes mount on the NestJS Fastify adapter's instance through createApiApp's `routes` hook.
describe('kill routes mounted on the API app', { timeout: 30_000 }, () => {
  let app: NestFastifyApplication;
  let h: Harness;

  beforeAll(async () => {
    h = harness();
    const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
    const logger = createLogger('api', { level: 'silent' });
    ({ app } = await createApiApp({
      config,
      logger,
      routes: [
        (instance) => {
          registerKillRoutes(instance, {
            service: h.service,
            environment: 'test',
            authenticate: (request) =>
              request.headers.authorization === 'Bearer admin'
                ? Promise.resolve(ADMIN)
                : Promise.reject(new AuthError('invalid or revoked token')),
          });
        },
      ],
    }));
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves POST /v1/kill and GET /v1/kill/{id} through the API bootstrap', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/kill',
      headers: { authorization: 'Bearer admin', 'idempotency-key': 'mount-key-0001' },
      payload: { scope: 'run', scopeRefId: LIVE_RUN, reason: 'mounted' },
    });
    expect(res.statusCode).toBe(202);
    const { killEventId } = res.json<{ killEventId: string }>();
    expect(res.headers.location).toBe(`/v1/kill/${killEventId}`);
    expect(h.store.list(TENANT_A)).toHaveLength(1);

    const got = await fastify.inject({
      method: 'GET',
      url: `/v1/kill/${killEventId}`,
      headers: { authorization: 'Bearer admin' },
    });
    expect(got.statusCode).toBe(200);
    expect(got.json<{ killEventId: string }>().killEventId).toBe(killEventId);
  });

  it('rejects an unauthenticated caller before the handler with problem+json', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/v1/kill',
        headers: { 'idempotency-key': 'mount-key-0002' },
        payload: { scope: 'run', scopeRefId: LIVE_RUN, reason: 'mounted' },
      });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});
