import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import {
  auditRecorder,
  cursors,
  FakeGraph,
  host,
  key,
  metrics,
  OTHER_TENANT,
  principal,
  RUN,
  runRecord,
  surfaceOf,
  TENANT,
} from './fixtures.test-helpers.js';
import { createCedarSurfacePolicy } from './policy.js';
import { RUN_SURFACE_ROUTE, registerRunSurfaceRoutes } from './routes.js';
import { SurfaceService } from './service.js';

import type { SurfacePrincipal, SurfaceRunReader } from './ports.js';

const TOKENS: Record<string, SurfacePrincipal | 'revoked'> = {
  admin: principal(['org_admin']),
  appsec: principal(['appsec_engineer']),
  reader: principal([]),
  other: principal(['org_admin'], { tenantId: OTHER_TENANT }),
  notenant: principal(['org_admin'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const hub = host('hub.example.test');

async function server(options: { foreignRun?: boolean; graph?: FakeGraph } = {}) {
  const app = Fastify();
  apps.push(app);
  const runs: SurfaceRunReader = {
    getRun: (tenantId) =>
      Promise.resolve(
        options.foreignRun === true
          ? null
          : runRecord({ tenantId: tenantId === TENANT ? TENANT : tenantId }),
      ),
  };
  const audit = auditRecorder();
  const service = new SurfaceService({
    runs,
    graph: options.graph ?? new FakeGraph(surfaceOf([{ node: hub, degree: 0 }])),
    policy: createCedarSurfacePolicy(),
    audit: audit.write,
    cursors: cursors(),
    metrics: metrics(),
  });
  registerRunSurfaceRoutes(app, {
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
  return { app, audit };
}

const get = (app: FastifyInstance, token: string | undefined, query = '') =>
  app.inject({
    method: 'GET',
    url: `${RUN_SURFACE_ROUTE.replace(':runId', RUN)}${query}`,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe('GET /v1/runs/:runId/surface', () => {
  it('answers 200 with the view and no-store caching', async () => {
    const { app, audit } = await server();
    const response = await get(app, 'appsec');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{ nodes: { id: string }[]; clusteredBy: string }>();
    expect(body.nodes.map((node) => node.id)).toEqual([key(hub)]);
    expect(body.clusteredBy).toBe('asset');
    expect(audit.events).toHaveLength(1);
  });

  it('answers 401 problem+json for a missing credential, without reading anything', async () => {
    const { app } = await server();
    const response = await get(app, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('answers 401 for a revoked credential', async () => {
    const { app } = await server();
    expect((await get(app, 'revoked')).statusCode).toBe(401);
  });

  it('answers 403 problem+json for a caller without run:read', async () => {
    const { app } = await server();
    const response = await get(app, 'reader');
    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('answers 403 for a caller with no tenant context', async () => {
    const { app } = await server();
    expect((await get(app, 'notenant')).statusCode).toBe(403);
  });

  it('answers 404 RUN_NOT_FOUND for a run of another tenant, uniform with a missing run', async () => {
    const { app } = await server({ foreignRun: true });
    const response = await get(app, 'other');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
  });

  it('answers 400 INVALID_QUERY for a limit over the cap', async () => {
    const { app } = await server();
    const response = await get(app, 'appsec', '?limit=500');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400, code: 'INVALID_QUERY' });
  });

  it('answers 400 INVALID_QUERY for a non-numeric limit', async () => {
    const { app } = await server();
    expect((await get(app, 'appsec', '?limit=ten')).json()).toMatchObject({
      code: 'INVALID_QUERY',
    });
  });

  it('answers 400 INVALID_CURSOR for a forged cursor', async () => {
    const { app } = await server();
    const response = await get(app, 'appsec', '?cursor=forged.value');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('answers 422 VALIDATION_FAILED for a malformed run id', async () => {
    const { app } = await server();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/runs/not-a-uuid/surface',
      headers: { authorization: 'Bearer appsec' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
