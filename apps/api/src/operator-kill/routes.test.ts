import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import {
  harness,
  type Harness,
  operator,
  RUN_A,
  RUN_B,
  SLUG_A,
  TENANT_A,
  tenantMember,
  uuid,
} from './fixtures.test-helpers.js';
import { registerOperatorKillRoutes } from './routes.js';

import type { OperatorPrincipal } from './ports.js';

/** Credentials the fake authenticator knows. `revoked` mimics a revoked/expired session. */
const TOKENS: Readonly<Record<string, OperatorPrincipal | 'revoked'>> = {
  operator: operator(),
  tenant: tenantMember(),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function server(h: Harness = harness()): Promise<{ app: FastifyInstance; h: Harness }> {
  const app = Fastify();
  apps.push(app);
  registerOperatorKillRoutes(app, {
    service: h.service,
    environment: 'test',
    authenticate: (request) => {
      const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
      const found = token === undefined ? undefined : TOKENS[token];
      if (found === undefined || found === 'revoked') {
        return Promise.reject(new AuthError('invalid or revoked session'));
      }
      return Promise.resolve(found);
    },
  });
  await app.ready();
  return { app, h };
}

const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

const post = (
  app: FastifyInstance,
  token: string,
  payload: unknown,
  key: string | null = `k-${uuid()}`,
) =>
  app.inject({
    method: 'POST',
    url: '/operator/v1/kill',
    headers: { ...auth(token), ...(key === null ? {} : { 'idempotency-key': key }) },
    payload: payload as object,
  });

const GLOBAL = { scope: 'global', reason: 'platform incident' };

describe('GET /operator/v1/kill/blast-radius', () => {
  it('returns the four counts for a global kill, uncached', async () => {
    const { app } = await server();
    const res = await app.inject({
      method: 'GET',
      url: '/operator/v1/kill/blast-radius?scope=global',
      headers: auth('operator'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      runsAffected: 2,
      sandboxesAffected: 3,
      tenantsAffected: 2,
      sessionsAffected: 3,
    });
  });

  it('returns the tenant slug for a tenant kill and 422/404 for bad input', async () => {
    const { app } = await server();
    const ok = await app.inject({
      method: 'GET',
      url: `/operator/v1/kill/blast-radius?scope=tenant&tenantId=${TENANT_A}`,
      headers: auth('operator'),
    });
    expect(ok.json<{ tenantSlug: string }>().tenantSlug).toBe(SLUG_A);
    const bad = await app.inject({
      method: 'GET',
      url: '/operator/v1/kill/blast-radius?scope=tenant',
      headers: auth('operator'),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    const unknown = await app.inject({
      method: 'GET',
      url: `/operator/v1/kill/blast-radius?scope=tenant&tenantId=${uuid()}`,
      headers: auth('operator'),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('POST /operator/v1/kill', () => {
  it('fires a global kill: 202, Location, one event, one signal, audited', async () => {
    const { app, h } = await server();
    const res = await post(app, 'operator', GLOBAL);
    expect(res.statusCode).toBe(202);
    const { killEventId, status } = res.json<{ killEventId: string; status: string }>();
    expect(status).toBe('initiated');
    expect(res.headers.location).toBe(`/operator/v1/kill/events/${killEventId}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await h.store.list(10)).toHaveLength(1);
    expect(h.signaler.requests).toHaveLength(1);
    expect(h.audit.records.some((r) => r.action === 'operator.kill_fired')).toBe(true);
  });

  it('answers problem+json with the stable code for each failure', async () => {
    const { app, h } = await server();
    const cases: readonly [
      string,
      Promise<{
        statusCode: number;
        json: () => { code: string };
        headers: Record<string, unknown>;
      }>,
      number,
      string,
    ][] = [
      ['missing key', post(app, 'operator', GLOBAL, null), 400, 'IDEMPOTENCY_KEY_REQUIRED'],
      ['no session', post(app, 'revoked', GLOBAL), 401, 'UNAUTHENTICATED'],
      ['tenant member', post(app, 'tenant', GLOBAL), 403, 'NOT_OPERATOR'],
      [
        'bad body',
        post(app, 'operator', { scope: 'tenant', reason: 'incident' }),
        422,
        'VALIDATION_FAILED',
      ],
      [
        'run scope',
        post(app, 'operator', { scope: 'run', reason: 'incident' }),
        422,
        'VALIDATION_FAILED',
      ],
    ];
    for (const [name, pending, status, code] of cases) {
      const res = await pending;
      expect(res.statusCode, name).toBe(status);
      expect(res.headers['content-type'], name).toContain('application/problem+json');
      expect(res.json().code, name).toBe(code);
    }
    expect(await h.store.list(10)).toHaveLength(0);
  });

  it('answers 422 for malformed JSON', async () => {
    const { app } = await server();
    const res = await app.inject({
      method: 'POST',
      url: '/operator/v1/kill',
      headers: {
        ...auth('operator'),
        'idempotency-key': 'bad-json-key',
        'content-type': 'application/json',
      },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(422);
  });

  it('answers 409 KILL_ALREADY_IN_PROGRESS for a second key and replays the same key', async () => {
    const { app, h } = await server();
    const first = await post(app, 'operator', GLOBAL, 'same-key-0001');
    const replay = await post(app, 'operator', GLOBAL, 'same-key-0001');
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    const second = await post(app, 'operator', GLOBAL, 'other-key-0002');
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('KILL_ALREADY_IN_PROGRESS');
    expect(await h.store.list(10)).toHaveLength(1);
  });

  it('answers 424 KILL_PARTIAL when the same key is replayed after a partial halt', async () => {
    const { app, h } = await server();
    const first = await post(app, 'operator', GLOBAL, 'partial-key-01');
    const { killEventId } = first.json<{ killEventId: string }>();
    const stored = await h.store.get(killEventId);
    if (stored === null) throw new Error('missing');
    h.store.put({
      ...stored,
      status: 'partially_halted',
      haltMs: 3000,
      affected: { sandboxResults: [{ sandboxId: 'sbx-b1', outcome: 'failed' }] },
    });
    const again = await post(app, 'operator', GLOBAL, 'partial-key-01');
    expect(again.statusCode).toBe(424);
    const problem = again.json<{ code: string; detail: string }>();
    expect(problem.code).toBe('KILL_PARTIAL');
    expect(problem.detail).toContain('sandbox sbx-b1');
  });

  it('answers 503 when the kill path cannot be reached, never 202', async () => {
    const down = harness({ signaler: { signal: () => Promise.reject(new Error('down')) } });
    const { app } = await server(down);
    const res = await post(app, 'operator', GLOBAL);
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('TEMPORAL_UNAVAILABLE');
  });
});

describe('GET /operator/v1/kill/events', () => {
  it('lists prior kills and one kill with its phases', async () => {
    const { app, h } = await server();
    const fired = await post(app, 'operator', {
      scope: 'tenant',
      tenantId: TENANT_A,
      reason: 'customer request',
    });
    const { killEventId } = fired.json<{ killEventId: string }>();

    const list = await app.inject({
      method: 'GET',
      url: '/operator/v1/kill/events',
      headers: auth('operator'),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({
        id: killEventId,
        scope: 'tenant',
        tenantId: TENANT_A,
        status: 'initiated',
        haltMs: null,
      }),
    ]);

    const one = await app.inject({
      method: 'GET',
      url: `/operator/v1/kill/events/${killEventId}`,
      headers: auth('operator'),
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: killEventId, egressBlockedAt: null, completedAt: null });
    expect(h.signaler.requests[0]?.targets.runIds).toEqual([RUN_A]);
    expect(h.signaler.requests[0]?.targets.runIds).not.toContain(RUN_B);

    const missing = await app.inject({
      method: 'GET',
      url: `/operator/v1/kill/events/${uuid()}`,
      headers: auth('operator'),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('authorisation (tenant members are kept out of every route)', () => {
  it.each([
    ['GET', '/operator/v1/kill/blast-radius?scope=global'],
    ['GET', '/operator/v1/kill/events'],
    ['GET', `/operator/v1/kill/events/${uuid()}`],
  ] as const)(
    '%s %s: 403 NOT_OPERATOR for a tenant member, 401 without a session',
    async (method, url) => {
      const { app } = await server();
      const member = await app.inject({ method, url, headers: auth('tenant') });
      expect(member.statusCode).toBe(403);
      expect(member.json<{ code: string }>().code).toBe('NOT_OPERATOR');
      const anonymous = await app.inject({ method, url });
      expect(anonymous.statusCode).toBe(401);
    },
  );
});
