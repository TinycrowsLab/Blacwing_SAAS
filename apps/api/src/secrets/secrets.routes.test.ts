import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { SECRET_VALUE_MAX_BYTES } from '@blackwing/contracts';
import { AuthError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import {
  admin,
  adminB,
  harness,
  type Harness,
  NON_ADMIN_ROLES,
  principal,
  TENANT_A,
  VALUE,
} from './fixtures.test-helpers.js';
import { registerSecretRoutes } from './routes.js';

import type { SecretPrincipal } from './ports.js';

/** Bearer tokens the fake authenticator knows. */
const TOKENS: Readonly<Record<string, SecretPrincipal | 'revoked'>> = {
  admin,
  adminb: adminB,
  ...Object.fromEntries(NON_ADMIN_ROLES.map((role) => [role.replace('_', ''), principal([role])])),
  notenant: principal(['org_admin'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function authenticate(request: { headers: { authorization?: string | undefined } }) {
  const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
  const found = token === undefined ? undefined : TOKENS[token];
  if (found === undefined || found === 'revoked') {
    return Promise.reject(new AuthError('invalid or revoked token'));
  }
  return Promise.resolve(found);
}

async function server(h: Harness = harness()) {
  const app = Fastify();
  apps.push(app);
  registerSecretRoutes(app, { service: h.service, environment: 'test', authenticate });
  await app.ready();
  return { app, h };
}

let seq = 0;
const send = (
  app: FastifyInstance,
  method: 'POST' | 'GET' | 'PUT' | 'DELETE',
  url: string,
  options: {
    token?: string | null;
    payload?: unknown;
    key?: string | null;
    headers?: Record<string, string>;
  } = {},
) => {
  const key =
    options.key === undefined
      ? method === 'POST'
        ? `route-key-${String((seq += 1)).padStart(6, '0')}`
        : null
      : options.key;
  return app.inject({
    method,
    url,
    headers: {
      ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? 'admin'}` }),
      ...(key === null ? {} : { 'idempotency-key': key }),
      ...options.headers,
    },
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
  });
};

const newSecret = { name: 'staging-api-key', type: 'api_key', value: VALUE };

async function created(app: FastifyInstance, payload: Record<string, unknown> = newSecret) {
  const res = await send(app, 'POST', '/v1/secrets', { payload });
  expect(res.statusCode).toBe(201);
  return res.json<{ secretId: string; secretRef: string; version: number }>();
}

// The first request loads the Cedar wasm module and Fastify; allow for a cold, busy CI worker.
describe('secrets routes', { timeout: 30_000 }, () => {
  it('POST /v1/secrets: 201 with Location, ETag, no-store and no value anywhere in the response', async () => {
    const { app, h } = await server();
    const res = await send(app, 'POST', '/v1/secrets', { payload: newSecret });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ secretId: string; secretRef: string; version: number }>();
    expect(Object.keys(body).sort()).toEqual(['secretId', 'secretRef', 'version']);
    expect(body.secretRef).toBe(`bw-secret://${TENANT_A}/${body.secretId}`);
    expect(res.headers.location).toBe(`/v1/secrets/${body.secretId}`);
    expect(res.headers.etag).toBe('"v1"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.payload).not.toContain(VALUE);
    expect(JSON.stringify(res.headers)).not.toContain(VALUE);
    expect(h.audit.records.map((r) => r.action)).toEqual(['secret.created']);
  });

  it('dedupes a retried POST with the same Idempotency-Key and flags the replay', async () => {
    const { app, h } = await server();
    const first = await send(app, 'POST', '/v1/secrets', {
      payload: newSecret,
      key: 'retry-key-0001',
    });
    const second = await send(app, 'POST', '/v1/secrets', {
      payload: newSecret,
      key: 'retry-key-0001',
    });
    expect(second.statusCode).toBe(201);
    expect(second.payload).toBe(first.payload);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    expect(h.store.count(TENANT_A).secrets).toBe(1);
    const changed = await send(app, 'POST', '/v1/secrets', {
      payload: { ...newSecret, value: 'other' },
      key: 'retry-key-0001',
    });
    expect(changed.statusCode).toBe(422);
    expect(changed.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('requires an Idempotency-Key on POST: 400 problem+json', async () => {
    const { app } = await server();
    const res = await send(app, 'POST', '/v1/secrets', { payload: newSecret, key: null });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('answers 409 SECRET_NAME_CONFLICT for a duplicate name', async () => {
    const { app } = await server();
    await created(app);
    const res = await send(app, 'POST', '/v1/secrets', { payload: newSecret });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('SECRET_NAME_CONFLICT');
    expect(res.payload).not.toContain(VALUE);
  });

  it('answers 413 SECRET_TOO_LARGE for an oversized value and for a body past the route limit', async () => {
    const { app, h } = await server();
    const big = await send(app, 'POST', '/v1/secrets', {
      payload: { ...newSecret, value: 'x'.repeat(SECRET_VALUE_MAX_BYTES + 1) },
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ code: string }>().code).toBe('SECRET_TOO_LARGE');
    const huge = await send(app, 'POST', '/v1/secrets', {
      payload: { ...newSecret, value: 'x'.repeat(SECRET_VALUE_MAX_BYTES * 9) },
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json<{ code: string }>().code).toBe('SECRET_TOO_LARGE');
    expect(h.store.count(TENANT_A).secrets).toBe(0);
  });

  it('answers 422 for malformed JSON without echoing any of the body', async () => {
    const { app } = await server();
    const res = await send(app, 'POST', '/v1/secrets', {
      payload: `{"name":"x","value":"${VALUE}"`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.payload).not.toContain(VALUE);
  });

  it('answers 422 listing field names only when validation fails', async () => {
    const { app } = await server();
    const res = await send(app, 'POST', '/v1/secrets', {
      payload: { name: '', value: VALUE, x: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toBe('invalid fields: name, (body)');
    expect(res.payload).not.toContain(VALUE);
  });

  it.each(NON_ADMIN_ROLES.map((role) => role.replace('_', '')))(
    '%s is denied on every route with 403 problem+json and no side effect',
    async (token) => {
      const { app, h } = await server();
      const { secretId } = await created(app);
      const calls = [
        send(app, 'POST', '/v1/secrets', { token, payload: { ...newSecret, name: 'other' } }),
        send(app, 'GET', '/v1/secrets', { token }),
        send(app, 'GET', `/v1/secrets/${secretId}`, { token }),
        send(app, 'PUT', `/v1/secrets/${secretId}`, { token, payload: { value: 'new' } }),
        send(app, 'DELETE', `/v1/secrets/${secretId}`, { token }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.statusCode).toBe(403);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
      }
      expect(h.store.count(TENANT_A)).toEqual({ secrets: 1, versions: 1 });
    },
  );

  it('answers 401 for a missing, revoked or tenantless credential', async () => {
    const { app } = await server();
    for (const options of [{ token: null }, { token: 'revoked' }, { token: 'nobody' }]) {
      const res = await send(app, 'GET', '/v1/secrets', options);
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    expect((await send(app, 'GET', '/v1/secrets', { token: 'notenant' })).statusCode).toBe(401);
  });

  it('GET /v1/secrets/{id} and the list return metadata only, with an ETag on the item', async () => {
    const { app } = await server();
    const { secretId, secretRef } = await created(app);
    const one = await send(app, 'GET', `/v1/secrets/${secretId}`);
    expect(one.statusCode).toBe(200);
    expect(one.headers.etag).toBe('"v1"');
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.json()).toMatchObject({
      secretId,
      secretRef,
      name: 'staging-api-key',
      type: 'api_key',
      purpose: null,
      backend: 'openbao',
      status: 'active',
      currentVersion: 1,
    });
    const list = await send(app, 'GET', '/v1/secrets?limit=10');
    expect(list.json<{ items: unknown[]; hasMore: boolean }>()).toMatchObject({ hasMore: false });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    for (const res of [one, list]) {
      expect(res.payload).not.toContain(VALUE);
      expect(res.payload).not.toMatch(/envelope|wrappedDek|"value"|ciphertext/);
    }
  });

  it('does not let one tenant see another tenant secret: 404 and an empty list', async () => {
    const { app } = await server();
    const { secretId } = await created(app);
    for (const res of [
      await send(app, 'GET', `/v1/secrets/${secretId}`, { token: 'adminb' }),
      await send(app, 'PUT', `/v1/secrets/${secretId}`, {
        token: 'adminb',
        payload: { value: 'x' },
      }),
      await send(app, 'DELETE', `/v1/secrets/${secretId}`, { token: 'adminb' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    expect((await send(app, 'GET', '/v1/secrets', { token: 'adminb' })).json()).toMatchObject({
      items: [],
    });
  });

  it('PUT: 200 with the new version and ETag; stale If-Match is 412, malformed is 428', async () => {
    const { app, h } = await server();
    const { secretId } = await created(app);
    const ok = await send(app, 'PUT', `/v1/secrets/${secretId}`, {
      payload: { value: 'second-value-xyz' },
      headers: { 'if-match': '"v1"' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ secretId, version: 2 });
    expect(ok.headers.etag).toBe('"v2"');
    expect(ok.payload).not.toContain('second-value-xyz');
    const stale = await send(app, 'PUT', `/v1/secrets/${secretId}`, {
      payload: { value: 'third' },
      headers: { 'if-match': '"v1"' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json<{ code: string }>().code).toBe('PRECONDITION_FAILED');
    const weak = await send(app, 'PUT', `/v1/secrets/${secretId}`, {
      payload: { value: 'third' },
      headers: { 'if-match': 'W/"v2"' },
    });
    expect(weak.statusCode).toBe(428);
    expect(h.store.count(TENANT_A).versions).toBe(2);
  });

  it('DELETE: 200 with the disabled metadata; a second DELETE is the same; ?force must be true or false', async () => {
    const { app } = await server();
    const { secretId } = await created(app);
    const res = await send(app, 'DELETE', `/v1/secrets/${secretId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ secretId, status: 'disabled' });
    expect(res.payload).not.toMatch(/envelope|"value"/);
    const again = await send(app, 'DELETE', `/v1/secrets/${secretId}`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ secretId, status: 'disabled' });
    expect((await send(app, 'GET', `/v1/secrets/${secretId}`)).json()).toMatchObject({
      status: 'disabled',
    });
    const bad = await send(app, 'DELETE', `/v1/secrets/${secretId}?force=maybe`);
    expect(bad.statusCode).toBe(422);
  });

  it('DELETE of a secret in use is 409 SECRET_IN_USE until ?force=true', async () => {
    const { app, h } = await server();
    const { secretId } = await created(app);
    h.references.push({ tenantId: TENANT_A, secretId, resourceType: 'asset_credential' });
    const blocked = await send(app, 'DELETE', `/v1/secrets/${secretId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'SECRET_IN_USE',
    });
    expect(blocked.json<{ detail: string }>().detail).toContain('asset_credential');
    expect((await send(app, 'DELETE', `/v1/secrets/${secretId}?force=true`)).statusCode).toBe(200);
  });

  it('answers 404 for a path id that is not a secret id', async () => {
    const { app } = await server();
    expect((await send(app, 'GET', '/v1/secrets/not-a-uuid')).statusCode).toBe(404);
  });

  it('fails closed with 503 and persists nothing when the tenant key is unavailable', async () => {
    const { app, h } = await server();
    h.transit.down = true;
    const res = await send(app, 'POST', '/v1/secrets', { payload: newSecret });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('KEK_UNAVAILABLE');
    expect(h.store.count(TENANT_A).secrets).toBe(0);
    expect(res.payload).not.toContain(VALUE);
  });
});

describe('secrets routes mounted on the API app', { timeout: 30_000 }, () => {
  it('serves through createApiApp and never logs the request body or the value', async () => {
    const h = harness();
    const lines: string[] = [];
    const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
    const logger = createLogger('api', {
      level: 'trace',
      nodeEnv: 'test',
      destination: { write: (line: string) => lines.push(line) },
    });
    const { app } = await createApiApp({
      config,
      logger,
      routes: [
        (instance) => {
          registerSecretRoutes(instance, { service: h.service, environment: 'test', authenticate });
        },
      ],
    });
    try {
      const fastify = app.getHttpAdapter().getInstance();
      await fastify.ready();
      const ok = await fastify.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: { authorization: 'Bearer admin', 'idempotency-key': 'mount-key-0001' },
        payload: newSecret,
      });
      expect(ok.statusCode).toBe(201);
      await fastify.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: { authorization: 'Bearer admin', 'idempotency-key': 'mount-key-0002' },
        payload: newSecret,
      });
      await fastify.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: { authorization: 'Bearer developer', 'idempotency-key': 'mount-key-0003' },
        payload: newSecret,
      });
      const denied = await fastify.inject({
        method: 'POST',
        url: '/v1/secrets',
        headers: { authorization: 'Bearer nobody', 'idempotency-key': 'mount-key-0004' },
        payload: newSecret,
      });
      expect(denied.statusCode).toBe(401);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain(VALUE);
      expect(h.logs.join('\n')).not.toContain(VALUE);
    } finally {
      await app.close();
    }
  });
});
