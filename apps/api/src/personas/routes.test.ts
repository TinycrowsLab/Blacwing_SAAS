import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import { principal, rolesWithout, TENANT_B } from './fixtures.test-helpers.js';
import { createInMemoryPersonaOverrideStore, RecordingPersonaAudit } from './memory.js';
import { createPersonaOverrideMetrics } from './metrics.js';
import { PERSONA_OVERRIDE_ROUTE, registerPersonaRoutes } from './routes.js';
import { PersonaOverrideService } from './service.js';

import type { PersonaPrincipal } from './ports.js';

const TOKENS: Record<string, PersonaPrincipal | 'revoked'> = {
  admin: principal(['org_admin']),
  appsec: principal(['appsec_engineer']),
  other: principal(['org_admin'], { tenantId: TENANT_B }),
  notenant: principal(['org_admin'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function server(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  const service = new PersonaOverrideService({
    store: createInMemoryPersonaOverrideStore(),
    writeAudit: (tx, event) => new RecordingPersonaAudit().write(tx, event),
    metrics: createPersonaOverrideMetrics(),
  });
  registerPersonaRoutes(app, {
    service,
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
  return app;
}

const url = (persona = 'osint') => PERSONA_OVERRIDE_ROUTE.replace(':persona', persona);

const get = (app: FastifyInstance, token: string, persona = 'osint') =>
  app.inject({ method: 'GET', url: url(persona), headers: { authorization: `Bearer ${token}` } });

const put = (app: FastifyInstance, token: string, payload: unknown, persona = 'osint') =>
  app.inject({
    method: 'PUT',
    url: url(persona),
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });

describe('persona override routes', () => {
  it('lets an org_admin set and read the override (200, no-store)', async () => {
    const app = await server();
    const written = await put(app, 'admin', { effort: 'low', maxTurns: 10 });
    expect(written.statusCode).toBe(200);
    expect(written.headers['cache-control']).toBe('no-store');
    expect(written.json()).toMatchObject({
      persona: 'osint',
      override: { effort: 'low', maxTurns: 10 },
    });

    const read = await get(app, 'admin');
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ override: { effort: 'low', maxTurns: 10 } });
  });

  it('answers 403 problem+json to every non-admin write', async () => {
    const app = await server();
    for (const role of rolesWithout('settings:write')) {
      const token = role;
      TOKENS[token] = principal([role]);
      const res = await put(app, token, { effort: 'low' });
      expect(res.statusCode, role).toBe(403);
      expect(res.headers['content-type'], role).toContain('application/problem+json');
      expect(res.json(), role).toMatchObject({ status: 403 });
    }
    expect((await put(app, 'appsec', { effort: 'low' })).statusCode).toBe(403);
  });

  it('refuses a forbidden field with OVERRIDE_FIELD_FORBIDDEN and writes nothing', async () => {
    const app = await server();
    const res = await put(app, 'admin', { allowedTools: ['Bash'] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ status: 403, code: 'OVERRIDE_FIELD_FORBIDDEN' });
    expect((await get(app, 'admin')).json()).toMatchObject({ override: null });
  });

  it('answers 422 VALIDATION_FAILED for a bad value and 422 PERSONA_UNKNOWN for a bad persona', async () => {
    const app = await server();
    expect((await put(app, 'admin', { maxTurns: -4 })).json()).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
    });
    expect((await put(app, 'admin', {}, 'not-a-persona')).json()).toMatchObject({
      status: 422,
      code: 'PERSONA_UNKNOWN',
    });
    expect((await get(app, 'admin', 'not-a-persona')).json()).toMatchObject({
      status: 422,
      code: 'PERSONA_UNKNOWN',
    });
  });

  it('answers 422 VALIDATION_FAILED for a non-object body', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'PUT',
      url: url(),
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      payload: '["effort"]',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a revoked or missing credential before the handler runs (401)', async () => {
    const app = await server();
    expect((await get(app, 'revoked')).statusCode).toBe(401);
    const none = await app.inject({ method: 'GET', url: url() });
    expect(none.statusCode).toBe(401);
    expect((await put(app, 'revoked', { effort: 'low' })).statusCode).toBe(401);
  });

  it('answers 403 when the caller has no tenant context', async () => {
    const app = await server();
    const res = await get(app, 'notenant');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
  });

  it('never returns another tenant’s override', async () => {
    const app = await server();
    await put(app, 'other', { maxTurns: 3 });
    expect((await get(app, 'admin')).json()).toMatchObject({ override: null, updatedAt: null });
  });
});
