import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import {
  harness,
  type Harness,
  LIVE_RUN,
  OWNED_ASSET,
  principal,
  TENANT_A,
  UNOWNED_ASSET,
  RUN_B,
} from './fixtures.test-helpers.js';
import { registerKillRoutes } from './routes.js';

import type { KillPrincipal } from './ports.js';

/** Bearer tokens the fake authenticator knows. `revoked` mimics a revoked/expired credential. */
const TOKENS: Readonly<Record<string, KillPrincipal | 'revoked'>> = {
  appsec: principal(['appsec_engineer']),
  owner: principal(['asset_owner']),
  admin: principal(['org_admin']),
  dev: principal(['developer']),
  notenant: principal(['org_admin'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

let handlerCalls = 0;

async function server(h: Harness = harness()): Promise<{ app: FastifyInstance; h: Harness }> {
  const app = Fastify();
  apps.push(app);
  handlerCalls = 0;
  const service = h.service;
  const counting = new Proxy(service, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && (prop === 'trigger' || prop === 'get')) {
        return (...args: unknown[]) => {
          handlerCalls += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  registerKillRoutes(app, {
    service: counting,
    environment: 'test',
    authenticate: (request) => {
      const token = /^Bearer (\w+)$/.exec(request.headers.authorization ?? '')?.[1];
      const found = token === undefined ? undefined : TOKENS[token];
      if (found === undefined || found === 'revoked') {
        return Promise.reject(new AuthError('invalid or revoked token'));
      }
      return Promise.resolve(found);
    },
  });
  await app.ready();
  return { app, h };
}

const post = (
  app: FastifyInstance,
  token: string,
  payload: unknown,
  key: string | null = `key-${Math.random().toString(36).slice(2, 12)}`,
) =>
  app.inject({
    method: 'POST',
    url: '/v1/kill',
    headers: {
      authorization: `Bearer ${token}`,
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    payload: payload as Record<string, unknown>,
  });

// The first request loads the Cedar wasm module and Fastify; allow for a cold, busy CI worker.
describe(
  'POST /v1/kill (integration: endpoint -> kill_event + audit + Temporal signal)',
  { timeout: 30_000 },
  () => {
    it('kills a run: 202, Location, one kill_events row, one kill.triggered audit, one signal', async () => {
      const { app, h } = await server();
      const res = await post(app, 'appsec', {
        scope: 'run',
        scopeRefId: LIVE_RUN,
        reason: 'spike',
      });
      expect(res.statusCode).toBe(202);
      const body = res.json<{ killEventId: string; status: string; triggeredAt: string }>();
      expect(body.status).toBe('initiated');
      expect(res.headers.location).toBe(`/v1/kill/${body.killEventId}`);
      expect(h.store.list(TENANT_A)).toHaveLength(1);
      expect(h.audit.records.filter((r) => r.action === 'kill.triggered')).toHaveLength(1);
      expect(h.audit.records[0]).toMatchObject({
        outcome: 'success',
        tenantId: TENANT_A,
        target: { type: 'run', id: LIVE_RUN },
        metadata: { killEventId: body.killEventId, 'targets.runs': 1, 'targets.sandboxes': 1 },
      });
      expect(h.signaler.requests).toEqual([
        expect.objectContaining({
          killEventId: body.killEventId,
          tenantId: TENANT_A,
          scope: 'run',
        }),
      ]);
      expect(h.signaler.requests[0]?.targets.runIds).toEqual([LIVE_RUN]);
      const metrics = await h.metrics.registry.getSingleMetricAsString('bw_kill_events_total');
      expect(metrics).toContain(
        'bw_kill_events_total{scope="run",source="api",status="initiated"} 1',
      );
    });

    it('replays the same killEventId for a repeated Idempotency-Key (no duplicate row or audit)', async () => {
      const { app, h } = await server();
      const payload = { scope: 'run', scopeRefId: LIVE_RUN, reason: 'spike' };
      const first = await post(app, 'appsec', payload, 'idem-key-0001');
      const second = await post(app, 'appsec', payload, 'idem-key-0001');
      expect(second.statusCode).toBe(202);
      expect(second.json<{ killEventId: string }>().killEventId).toBe(
        first.json<{ killEventId: string }>().killEventId,
      );
      expect(h.store.list(TENANT_A)).toHaveLength(1);
      expect(h.audit.records).toHaveLength(1);
      expect(h.signaler.requests).toHaveLength(1);
    });

    it('GET /v1/kill/{id} returns the event with its halt timings', async () => {
      const { app } = await server();
      const created = await post(app, 'appsec', {
        scope: 'run',
        scopeRefId: LIVE_RUN,
        reason: 'spike',
      });
      const id = created.json<{ killEventId: string }>().killEventId;
      const res = await app.inject({
        method: 'GET',
        url: `/v1/kill/${id}`,
        headers: { authorization: 'Bearer appsec' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        killEventId: id,
        scope: 'run',
        status: 'initiated',
        source: 'api',
        egressBlockedAt: null,
        haltMs: null,
      });
    });

    it('answers problem+json with the stable code for invalid input', async () => {
      const { app } = await server();
      const cases = [
        [{ scope: 'global', reason: 'all of it' }, 403, 'KILL_GLOBAL_NOT_ALLOWED_HERE'],
        [{ scope: 'planet', reason: 'nope' }, 422, 'KILL_SCOPE_INVALID'],
        [{ scope: 'run', reason: 'which run' }, 422, 'KILL_REF_REQUIRED'],
        [{ scope: 'run', scopeRefId: LIVE_RUN, reason: 'x' }, 422, 'VALIDATION_FAILED'],
      ] as const;
      for (const [payload, status, code] of cases) {
        const res = await post(app, 'admin', payload);
        expect(res.statusCode).toBe(status);
        expect(res.headers['content-type']).toContain('application/problem+json');
        expect(res.json()).toMatchObject({ status, code });
      }
      const noKey = await post(app, 'admin', { scope: 'tenant', reason: 'stop' }, null);
      expect(noKey.json()).toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    });

    it('rejects a revoked or expired token before the handler runs (401)', async () => {
      const { app, h } = await server();
      const res = await post(app, 'revoked', {
        scope: 'run',
        scopeRefId: LIVE_RUN,
        reason: 'spike',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(handlerCalls).toBe(0);
      expect(h.store.list(TENANT_A)).toHaveLength(0);
    });

    it('fails closed without tenant context (401, nothing written)', async () => {
      const { app, h } = await server();
      const res = await post(app, 'notenant', { scope: 'tenant', reason: 'stop all' });
      expect(res.statusCode).toBe(401);
      expect(h.audit.records).toHaveLength(0);
      expect(h.signaler.requests).toHaveLength(0);
    });

    it('does not reveal another tenant run (404) and writes nothing', async () => {
      const { app, h } = await server();
      const res = await post(app, 'admin', { scope: 'run', scopeRefId: RUN_B, reason: 'not mine' });
      expect(res.statusCode).toBe(404);
      expect(h.store.list(TENANT_A)).toHaveLength(0);
      expect(h.signaler.requests).toHaveLength(0);
    });
  },
);

describe('kill authz e2e matrix (role x scope)', { timeout: 30_000 }, () => {
  it('kill.authz.assetOwnerScope: asset_owner killing an unowned asset gets 403 KILL_FORBIDDEN', async () => {
    const { app, h } = await server();
    const res = await post(app, 'owner', {
      scope: 'asset',
      scopeRefId: UNOWNED_ASSET,
      reason: 'stop',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'KILL_FORBIDDEN', status: 403 });
    expect(h.store.list(TENANT_A)).toHaveLength(0);
    expect(h.audit.records).toEqual([
      expect.objectContaining({ action: 'kill.forbidden', outcome: 'denied' }),
    ]);
    const owned = await post(app, 'owner', {
      scope: 'asset',
      scopeRefId: OWNED_ASSET,
      reason: 'stop',
    });
    expect(owned.statusCode).toBe(202);
  });

  const MATRIX = [
    ['appsec', 'run', 202],
    ['appsec', 'asset', 202],
    ['appsec', 'tenant', 403],
    ['owner', 'run', 403],
    ['owner', 'tenant', 403],
    ['admin', 'run', 202],
    ['admin', 'asset', 202],
    ['admin', 'tenant', 202],
    ['dev', 'run', 403],
    ['dev', 'asset', 403],
    ['dev', 'tenant', 403],
  ] as const;

  it.each(MATRIX)('%s on %s scope -> %i', async (token, scope, status) => {
    const { app, h } = await server();
    const ref = scope === 'run' ? LIVE_RUN : scope === 'asset' ? OWNED_ASSET : undefined;
    const res = await post(app, token, {
      scope,
      ...(ref === undefined ? {} : { scopeRefId: ref }),
      reason: 'matrix',
    });
    expect(res.statusCode).toBe(status);
    const action = status === 202 ? 'kill.triggered' : 'kill.forbidden';
    expect(h.audit.records.map((r) => r.action)).toEqual([action]);
    const expected = status === 202 ? { status: 'initiated' } : { code: 'KILL_FORBIDDEN' };
    expect(res.json()).toMatchObject(expected);
  });
});
