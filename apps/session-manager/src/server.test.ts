import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createSessionManagerMetrics } from './metrics.js';
import { createReadinessMonitor, type DependencyProbe } from './readiness.js';
import { internalSessionRoutes } from './routes.js';
import { buildServer } from './server.js';
import { createTokenVerifier, signControlToken, signRunToken } from './tokens.js';

import type { FastifyInstance, FastifyPluginCallback } from 'fastify';

const RUN_KEY = 'r'.repeat(48);
const CONTROL_KEY = 'c'.repeat(48);
const TENANT = '0192f5a0-0000-7000-8000-000000000001';
const OTHER_TENANT = '0192f5a0-0000-7000-8000-000000000002';
const RUN = '0192f5a0-0000-7000-8000-0000000000aa';
const OTHER_RUN = '0192f5a0-0000-7000-8000-0000000000bb';
const MAX_BODY = 256;

function toggle(name: string): DependencyProbe & { up: boolean } {
  const probe = {
    name,
    up: false,
    check: () => (probe.up ? Promise.resolve() : Promise.reject(new Error('down'))),
  };
  return probe;
}

function runToken(tenantId = TENANT, runId = RUN): string {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signRunToken(RUN_KEY, { tenantId, runId, issuedAt: now, expiresAt: now + 600 })}`;
}

function controlToken(tenantId = TENANT): string {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${signControlToken(CONTROL_KEY, { tenantId, issuedAt: now, expiresAt: now + 600 })}`;
}

/** The JSON body of a response, typed as an untyped record (a problem+json or an echo). */
function problem(res: { json(): unknown }): Record<string, unknown> {
  return res.json() as Record<string, unknown>;
}

/** A test-only POST route under the protected prefix, so body limits can be exercised after auth. */
const echoRoute: FastifyPluginCallback = (scope, _options, done) => {
  scope.post('/echo', (request, reply) => reply.send({ ok: true, body: request.body }));
  done();
};

interface Harness {
  readonly app: FastifyInstance;
  readonly postgres: DependencyProbe & { up: boolean };
  readonly valkey: DependencyProbe & { up: boolean };
  readonly openbao: DependencyProbe & { up: boolean };
  readonly readiness: ReturnType<typeof createReadinessMonitor>;
  readonly logs: string[];
}

let current: Harness | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function harness(): Harness {
  const logs: string[] = [];
  const logger = createLogger('session-manager', {
    level: 'debug',
    nodeEnv: 'test',
    destination: { write: (line: string) => logs.push(line) },
  });
  const postgres = toggle('postgres');
  const valkey = toggle('valkey');
  const openbao = toggle('openbao');
  const readiness = createReadinessMonitor({ probes: [postgres, valkey, openbao] });
  const app = buildServer({
    logger,
    verifier: createTokenVerifier({ runSecret: RUN_KEY, controlSecret: CONTROL_KEY }),
    readiness,
    metrics: createSessionManagerMetrics('0.0.0', 'abc123'),
    maxBodyBytes: MAX_BODY,
    environment: 'test',
    internalRoutes: (scope, options, done) => {
      internalSessionRoutes(scope, options, () => undefined);
      echoRoute(scope, options, done);
    },
  });
  current = { app, postgres, valkey, openbao, readiness, logs };
  return current;
}

describe('health, readiness and metrics', () => {
  it('/healthz is 200 regardless of dependencies', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(problem(res)).toEqual({ status: 'ok' });
  });

  it('/readyz is 503 until PostgreSQL, Valkey and OpenBao are all reachable', async () => {
    const { app, postgres, valkey, openbao, readiness } = harness();
    const readyz = async (): Promise<number> =>
      (await app.inject({ method: 'GET', url: '/readyz' })).statusCode;

    expect(await readyz()).toBe(503);
    postgres.up = true;
    valkey.up = true;
    await readiness.checkNow();
    expect(await readyz()).toBe(503);
    openbao.up = true;
    await readiness.checkNow();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(problem(res)).toEqual({
      status: 'ready',
      checks: { postgres: true, valkey: true, openbao: true },
    });
    expect(res.headers['cache-control']).toBe('no-store');

    openbao.up = false;
    await readiness.checkNow();
    expect(await readyz()).toBe(503);
  });

  it('/metrics exposes sm_up, sm_ready and sm_build_info', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('sm_up ');
    expect(res.body).toContain('sm_ready 0');
    expect(res.body).toContain('sm_build_info{version="0.0.0",commit="abc123"} 1');
  });
});

describe('internal API authentication and scope', () => {
  it('answers 401 SM_UNAUTHENTICATED problem+json with no token, and never reaches a handler', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/scope`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(problem(res)).toMatchObject({ code: 'SM_UNAUTHENTICATED', status: 401 });
  });

  it('answers 401 for a forged token, and the same body for every refusal reason', async () => {
    const { app } = harness();
    const url = `/internal/sessions/tenants/${TENANT}/scope`;
    const bad = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer bw_run_x.y' },
    });
    const none = await app.inject({ method: 'GET', url });
    expect(bad.statusCode).toBe(401);
    expect(problem(bad).code).toBe('SM_UNAUTHENTICATED');
    expect(problem(bad).detail).toBe(problem(none).detail);
  });

  it('answers 401 for an unmatched path under the prefix without a token (the guard covers the whole prefix)', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/internal/sessions/nowhere' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for an unmatched path under the prefix with a valid token', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: '/internal/sessions/nowhere',
      headers: { authorization: controlToken() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers 403 SM_TENANT_MISMATCH when a control token names another tenant', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${OTHER_TENANT}/scope`,
      headers: { authorization: controlToken(TENANT) },
    });
    expect(res.statusCode).toBe(403);
    expect(problem(res)).toMatchObject({ code: 'SM_TENANT_MISMATCH', status: 403 });
  });

  it('answers 403 when a run token is used on another tenant or another run', async () => {
    const { app } = harness();
    const crossTenant = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${OTHER_TENANT}/runs/${RUN}/scope`,
      headers: { authorization: runToken(TENANT, RUN) },
    });
    const crossRun = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/runs/${OTHER_RUN}/scope`,
      headers: { authorization: runToken(TENANT, RUN) },
    });
    expect(crossTenant.statusCode).toBe(403);
    expect(crossRun.statusCode).toBe(403);
  });

  it('answers 200 for a run token on its own run, and reports the run scope', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/runs/${RUN}/scope`,
      headers: { authorization: runToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(problem(res)).toEqual({ tenantId: TENANT, runId: RUN, kind: 'run' });
  });

  it('answers 200 for a control token on its tenant-level route and refuses it on a run route', async () => {
    const { app } = harness();
    const tenantLevel = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/scope`,
      headers: { authorization: controlToken() },
    });
    const runLevel = await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/runs/${RUN}/scope`,
      headers: { authorization: controlToken() },
    });
    expect(problem(tenantLevel)).toEqual({ tenantId: TENANT, kind: 'control' });
    expect(runLevel.statusCode).toBe(403);
  });

  it('counts and logs a rejected token without logging the token itself', async () => {
    const { app, logs } = harness();
    const token = 'bw_run_SECRETPAYLOAD.SECRETSIG';
    await app.inject({
      method: 'GET',
      url: `/internal/sessions/tenants/${TENANT}/scope`,
      headers: { authorization: `Bearer ${token}` },
    });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('sm_auth_failures_total{reason="bad_signature"} 1');
    expect(logs.join('\n')).toContain('sm.auth.rejected');
    expect(logs.join('\n')).not.toContain('SECRETPAYLOAD');
    expect(logs.join('\n')).not.toContain('SECRETSIG');
  });
});

describe('request body handling', () => {
  it('refuses an oversized body with 400 SM_BAD_REQUEST before any handler runs', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sessions/echo',
      headers: { authorization: controlToken(), 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(MAX_BODY * 2) }),
    });
    expect(res.statusCode).toBe(400);
    expect(problem(res)).toMatchObject({ code: 'SM_BAD_REQUEST', status: 400 });
  });

  it('refuses malformed JSON with 400 SM_BAD_REQUEST', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sessions/echo',
      headers: { authorization: controlToken(), 'content-type': 'application/json' },
      payload: '{"unterminated":',
    });
    expect(res.statusCode).toBe(400);
    expect(problem(res).code).toBe('SM_BAD_REQUEST');
  });

  it('refuses a non-JSON content type with 400 SM_BAD_REQUEST', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sessions/echo',
      headers: { authorization: controlToken(), 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(res.statusCode).toBe(400);
    expect(problem(res).code).toBe('SM_BAD_REQUEST');
  });

  it('parses a valid JSON body for an authenticated caller', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sessions/echo',
      headers: { authorization: controlToken(), 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(problem(res)).toEqual({ ok: true, body: { a: 1 } });
  });

  it('never parses a body from an unauthenticated caller', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sessions/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"unterminated":',
    });
    expect(res.statusCode).toBe(401);
  });
});
