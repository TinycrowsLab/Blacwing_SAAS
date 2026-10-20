import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createHmacRunTokenVerifier, signRunToken } from './auth.js';
import { createControllerMetrics } from './metrics.js';
import { createReadinessMonitor, type DependencyProbe } from './readiness.js';
import { buildServer } from './server.js';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

const SECRET = 'q'.repeat(48);
const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f5a0-0000-7000-8000-000000000002';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';
const MAX_BODY = 256;

function toggle(name: string): DependencyProbe & { up: boolean } {
  const probe = {
    name,
    up: false,
    check: () => (probe.up ? Promise.resolve() : Promise.reject(new Error('down'))),
  };
  return probe;
}

function token(tenantId = TENANT, runId = RUN): string {
  const now = Math.floor(Date.now() / 1000);
  return signRunToken(SECRET, { tenantId, runId, issuedAt: now, expiresAt: now + 600 });
}

interface Harness {
  readonly app: FastifyInstance;
  readonly driver: DependencyProbe & { up: boolean };
  readonly valkey: DependencyProbe & { up: boolean };
  readonly readiness: ReturnType<typeof createReadinessMonitor>;
  readonly handler: ReturnType<typeof vi.fn>;
  readonly logs: string[];
}

let current: Harness | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function harness(): Harness {
  const logs: string[] = [];
  const logger = createLogger('sandbox-controller', {
    level: 'debug',
    nodeEnv: 'test',
    destination: { write: (line: string) => logs.push(line) },
  });
  const driver = toggle('driver');
  const valkey = toggle('valkey');
  const readiness = createReadinessMonitor({ probes: [driver, valkey] });
  const handler = vi.fn();
  const routes: FastifyPluginAsync = (scope) => {
    scope.get('/:sandboxId', (request, reply) => {
      handler();
      return reply.send({ context: request.runContext });
    });
    scope.post('/', (request, reply) => {
      handler(request.body);
      return reply.send({ ok: true });
    });
    return Promise.resolve();
  };
  const app = buildServer({
    logger,
    verifier: createHmacRunTokenVerifier({ secret: SECRET }),
    readiness,
    metrics: createControllerMetrics('0.0.0', 'abc123'),
    maxBodyBytes: MAX_BODY,
    environment: 'test',
    internalRoutes: routes,
  });
  current = { app, driver, valkey, readiness, handler, logs };
  return current;
}

describe('health and readiness', () => {
  it('/healthz is 200', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/readyz is 503 until the fake driver and Valkey are both marked reachable', async () => {
    const { app, driver, valkey, readiness } = harness();
    const readyz = async (): Promise<number> =>
      (await app.inject({ method: 'GET', url: '/readyz' })).statusCode;

    expect(await readyz()).toBe(503);
    driver.up = true;
    await readiness.checkNow();
    expect(await readyz()).toBe(503);
    valkey.up = true;
    await readiness.checkNow();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { driver: true, valkey: true } });

    valkey.up = false;
    await readiness.checkNow();
    expect(await readyz()).toBe(503);
  });

  it('/metrics exposes sbx_up, sbx_ready and sbx_build_info', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('sbx_up ');
    expect(res.body).toContain('sbx_ready 0');
    expect(res.body).toContain('sbx_build_info{version="0.0.0",commit="abc123"} 1');
  });
});

describe('run-token authentication on /internal/sandboxes/*', () => {
  it('returns 401 problem+json SBX_UNAUTHENTICATED without a token', async () => {
    const { app, handler } = harness();
    const res = await app.inject({ method: 'GET', url: '/internal/sandboxes/sbx-1' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://errors.blackwing.dev/SBX_UNAUTHENTICATED',
      status: 401,
      code: 'SBX_UNAUTHENTICATED',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['a PAT', 'Bearer bw_pat_0123456789'],
    [
      'a forged run token',
      `Bearer ${signRunToken('w'.repeat(48), { tenantId: TENANT, runId: RUN, expiresAt: 4_000_000_000 })}`,
    ],
    [
      'an expired run token',
      `Bearer ${signRunToken(SECRET, { tenantId: TENANT, runId: RUN, issuedAt: 1, expiresAt: 2 })}`,
    ],
  ])('returns 401 for %s, with the same body for every reason', async (_label, authorization) => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/sandboxes/sbx-1',
      headers: { authorization },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: 'SBX_UNAUTHENTICATED',
      detail: 'A valid run-scoped bearer token is required.',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('protects unmatched and re-encoded paths too (401 before 404)', async () => {
    const { app } = harness();
    for (const url of [
      '/internal/sandboxes/no/such/route',
      '/internal/%73andboxes/x',
      '/internal/sandboxes',
    ]) {
      const res = await app.inject({ method: 'DELETE', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('attaches the tenant and run from a valid token', async () => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/sandboxes/sbx-1',
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ context: { tenantId: TENANT, runId: RUN } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('edge case: a token for another tenant only attaches that context (403 is enforced by later issues)', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/sandboxes/sbx-of-tenant-1',
      headers: { authorization: `Bearer ${token(OTHER_TENANT)}` },
    });
    expect(res.json()).toMatchObject({ context: { tenantId: OTHER_TENANT, runId: RUN } });
  });

  it('logs tenant_id, run_id and sandbox_id, never the token', async () => {
    const { app, logs } = harness();
    const t = token();
    await app.inject({
      method: 'GET',
      url: '/internal/sandboxes/sbx-42',
      headers: { authorization: `Bearer ${t}` },
    });
    await app.inject({
      method: 'GET',
      url: '/internal/sandboxes/sbx-42',
      headers: { authorization: `Bearer ${t}x` },
    });
    const text = logs.join('');
    expect(text).not.toContain(t.slice('bw_run_'.length, 40));
    const request = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'sbx.request');
    expect(request).toMatchObject({
      tenant_id: TENANT,
      run_id: RUN,
      sandbox_id: 'sbx-42',
      component: 'api',
      status: 200,
    });
    const rejected = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === 'sbx.auth.rejected');
    expect(rejected).toMatchObject({ component: 'auth', reason: 'bad_signature' });
  });

  it('counts rejections by reason in sbx_auth_failures_total', async () => {
    const { app } = harness();
    await app.inject({ method: 'GET', url: '/internal/sandboxes/x' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('sbx_auth_failures_total{reason="missing"} 1');
  });
});

describe('request bodies', () => {
  const auth = (): Record<string, string> => ({
    authorization: `Bearer ${token()}`,
    'content-type': 'application/json',
  });

  it('edge case: malformed JSON is 400 problem+json and no handler runs', async () => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: auth(),
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'SBX_BAD_REQUEST', status: 400 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('edge case: an oversized body is 400 problem+json and no handler runs', async () => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: auth(),
      payload: JSON.stringify({ pad: 'x'.repeat(MAX_BODY * 2) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'SBX_BAD_REQUEST' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a non-JSON content type with 400', async () => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: { ...auth(), 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks the token before reading the body', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid JSON body', async () => {
    const { app, handler } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sandboxes',
      headers: auth(),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledWith({ a: 1 });
  });

  it('answers unknown public paths with a 404 problem', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
