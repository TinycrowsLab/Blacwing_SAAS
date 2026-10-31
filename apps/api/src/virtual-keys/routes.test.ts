import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { createFakeVirtualKeyStore } from './fakes.test-helpers.js';
import { createVirtualKeyMetrics } from './metrics.js';
import {
  registerVirtualKeyRoutes,
  VKEY_MINT_ROUTE,
  VKEY_REVOKE_ROUTE,
  VKEY_VALIDATE_ROUTE,
} from './routes.js';
import { createVirtualKeyService } from './service.js';
import { createSourceGuard } from '../broker/network.js';

const IDENTITY_HEADER = 'x-bw-mesh-identity';
const INTERNAL = { [IDENTITY_HEADER]: 'api-internal' };
const INTERNAL_ADDRESS = '10.20.0.7';
const TENANT = newId();
const RUN = newId();

let app: FastifyInstance;
let mintLimit: number;

function build(limit: number): FastifyInstance {
  mintLimit = limit;
  const metrics = createVirtualKeyMetrics();
  const service = createVirtualKeyService({
    store: createFakeVirtualKeyStore(),
    audit: () => Promise.resolve(),
    systemAudit: () => undefined,
    metrics,
  });
  const instance = Fastify({ logger: false });
  registerVirtualKeyRoutes(instance, {
    service,
    sourceGuard: createSourceGuard({
      allowedCidrs: ['10.20.0.0/16'],
      identityHeader: IDENTITY_HEADER,
      identities: ['api-internal'],
    }),
    metrics,
    logger: createLogger('vkey-routes-test', { level: 'silent', nodeEnv: 'test' }),
    identityHeader: IDENTITY_HEADER,
    mintRateLimitPerMinute: mintLimit,
  });
  return instance;
}

const mintPayload = { tenantId: TENANT, runId: RUN, sessionId: newId(), persona: 'planner' };

beforeEach(() => {
  app = build(60);
});

afterEach(async () => {
  await app.close();
});

describe('internal virtual key routes: source guard', () => {
  it('refuses a request from outside the internal network, even with the identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: VKEY_MINT_ROUTE,
      headers: INTERNAL,
      payload: mintPayload,
      remoteAddress: '203.0.113.9',
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('bwk_');
  });

  it('refuses a request without the mesh identity header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: VKEY_MINT_ROUTE,
      payload: mintPayload,
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(response.statusCode).toBe(403);
  });

  it('ignores X-Forwarded-For: a spoofed header never admits a request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: VKEY_MINT_ROUTE,
      headers: { ...INTERNAL, 'x-forwarded-for': INTERNAL_ADDRESS },
      payload: mintPayload,
      remoteAddress: '203.0.113.9',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('internal virtual key routes: mint, revoke, validate', () => {
  it('mints a key over the internal network, with no-store caching', async () => {
    const response = await app.inject({
      method: 'POST',
      url: VKEY_MINT_ROUTE,
      headers: INTERNAL,
      payload: mintPayload,
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ key: string; virtualKeyId: string; expiresAt: string }>();
    expect(body.key).toMatch(/^bwk_[0-9A-Za-z]{43}$/);
    expect(body.expiresAt).toMatch(/Z$/);
  });

  it('rejects a mint without a tenant with a client error and no key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: VKEY_MINT_ROUTE,
      headers: INTERNAL,
      payload: { ...mintPayload, tenantId: undefined },
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.body).not.toContain('bwk_');
  });

  it('rate limits mint per tenant with a 429 and Retry-After', async () => {
    await app.close();
    app = build(2);
    const send = () =>
      app.inject({
        method: 'POST',
        url: VKEY_MINT_ROUTE,
        headers: INTERNAL,
        payload: mintPayload,
        remoteAddress: INTERNAL_ADDRESS,
      });
    expect((await send()).statusCode).toBe(201);
    expect((await send()).statusCode).toBe(201);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('validates a live key and answers one uniform 401 for every refusal', async () => {
    const minted = (
      await app.inject({
        method: 'POST',
        url: VKEY_MINT_ROUTE,
        headers: INTERNAL,
        payload: mintPayload,
        remoteAddress: INTERNAL_ADDRESS,
      })
    ).json<{ key: string }>();
    const ok = await app.inject({
      method: 'POST',
      url: VKEY_VALIDATE_ROUTE,
      headers: INTERNAL,
      payload: { key: minted.key },
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ tenantId: TENANT, runId: RUN, persona: 'planner' });

    const unknown = await app.inject({
      method: 'POST',
      url: VKEY_VALIDATE_ROUTE,
      headers: INTERNAL,
      payload: { key: 'bwk_' + 'A'.repeat(43) },
      remoteAddress: INTERNAL_ADDRESS,
    });
    const malformed = await app.inject({
      method: 'POST',
      url: VKEY_VALIDATE_ROUTE,
      headers: INTERNAL,
      payload: { key: 'nope' },
      remoteAddress: INTERNAL_ADDRESS,
    });
    const missing = await app.inject({
      method: 'POST',
      url: VKEY_VALIDATE_ROUTE,
      headers: INTERNAL,
      payload: {},
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(unknown.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    // The trace id is per request; everything else in the refusal must be identical.
    const withoutTrace = (response: { json: () => Record<string, unknown> }) =>
      Object.fromEntries(Object.entries(response.json()).filter(([key]) => key !== 'traceId'));
    expect(withoutTrace(unknown)).toEqual(withoutTrace(malformed));
    expect(withoutTrace(malformed)).toEqual(withoutTrace(missing));
  });

  it('revokes a run over the internal network and then refuses its key', async () => {
    const minted = (
      await app.inject({
        method: 'POST',
        url: VKEY_MINT_ROUTE,
        headers: INTERNAL,
        payload: mintPayload,
        remoteAddress: INTERNAL_ADDRESS,
      })
    ).json<{ key: string }>();
    const revoke = await app.inject({
      method: 'POST',
      url: VKEY_REVOKE_ROUTE,
      headers: INTERNAL,
      payload: { tenantId: TENANT, runId: RUN },
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<{ revokedVirtualKeyIds: string[] }>().revokedVirtualKeyIds).toHaveLength(1);
    const after = await app.inject({
      method: 'POST',
      url: VKEY_VALIDATE_ROUTE,
      headers: INTERNAL,
      payload: { key: minted.key },
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(after.statusCode).toBe(401);
  });

  it('answers 404 for an unknown path inside the internal surface', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/keys:unknown',
      headers: INTERNAL,
      remoteAddress: INTERNAL_ADDRESS,
    });
    expect(response.statusCode).toBe(404);
  });
});
