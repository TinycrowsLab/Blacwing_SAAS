import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import { principal, TENANT_B } from './fixtures.test-helpers.js';
import { createInMemoryPersonaOverrideStore, RecordingPersonaAudit } from './memory.js';
import { createPersonaOverrideMetrics, createPersonaRegistryMetrics } from './metrics.js';
import { PersonaRegistryService } from './registry.js';
import {
  PERSONA_COLLECTION_ROUTE,
  PERSONA_ITEM_ROUTE,
  registerPersonaRegistryRoutes,
} from './routes.js';
import { PersonaOverrideService } from './service.js';

import type { PersonaPrincipal } from './ports.js';

const TOKENS: Record<string, PersonaPrincipal | 'revoked'> = {
  auditor: principal(['auditor']),
  developer: principal(['developer']),
  admin: principal(['org_admin']),
  other: principal(['ci_pipeline'], { tenantId: TENANT_B }),
  notenant: principal(['auditor'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function server(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  const overrides = new PersonaOverrideService({
    store: createInMemoryPersonaOverrideStore(),
    writeAudit: (tx, event) => new RecordingPersonaAudit().write(tx, event),
    metrics: createPersonaOverrideMetrics(),
  });
  const registry = new PersonaRegistryService({
    overrides,
    provider: 'anthropic',
    metrics: createPersonaRegistryMetrics(),
  });
  registerPersonaRegistryRoutes(app, {
    registry,
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

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

describe('persona registry routes (REGISTRY-011)', () => {
  it('serves the full roster to a tenant member (200, no-store)', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: PERSONA_COLLECTION_ROUTE,
      headers: authed('auditor'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body: { items: { name: string }[] } = res.json();
    expect(body.items).toHaveLength(19);
    expect(body.items[0]).toMatchObject({ name: 'orchestrator' });
  });

  it('serves one persona to every tenant role, with the tenant effective settings', async () => {
    const app = await server();
    for (const token of ['auditor', 'developer', 'admin']) {
      const res = await app.inject({
        method: 'GET',
        url: PERSONA_ITEM_ROUTE.replace(':persona', 'planner'),
        headers: authed(token),
      });
      expect(res.statusCode, token).toBe(200);
      expect(res.headers['cache-control'], token).toBe('no-store');
      expect(res.json(), token).toMatchObject({
        name: 'planner',
        effective: { model: 'claude-opus-5-5', effort: 'high', maxTurns: 40 },
      });
    }
  });

  it('answers 401 for a missing or revoked credential, before the handler runs', async () => {
    const app = await server();
    const none = await app.inject({ method: 'GET', url: PERSONA_COLLECTION_ROUTE });
    expect(none.statusCode).toBe(401);
    const revoked = await app.inject({
      method: 'GET',
      url: PERSONA_ITEM_ROUTE.replace(':persona', 'planner'),
      headers: authed('revoked'),
    });
    expect(revoked.statusCode).toBe(401);
  });

  it('answers 403 problem+json when the caller has no tenant context', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: PERSONA_COLLECTION_ROUTE,
      headers: authed('notenant'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 403, code: 'TENANT_CONTEXT_MISSING' });
  });

  it('answers 422 PERSONA_UNKNOWN for a name outside the roster', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: PERSONA_ITEM_ROUTE.replace(':persona', 'not-a-persona'),
      headers: authed('auditor'),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: 422, code: 'PERSONA_UNKNOWN' });
  });

  it('keeps the tenant boundary: another tenant sees the same base roster with its own overrides', async () => {
    const app = await server();
    const res = await app.inject({
      method: 'GET',
      url: PERSONA_ITEM_ROUTE.replace(':persona', 'planner'),
      headers: authed('other'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ overridden: [] });
  });
});
