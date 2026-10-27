import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError } from '@blackwing/errors';

import {
  AUDITOR,
  harness,
  ledgerRow,
  ORG_ADMIN,
  principal,
  TENANT_A,
} from './fixtures.test-helpers.js';
import { AUDIT_EVENTS_ROUTE, registerAuditQueryRoutes } from './routes.js';

import type { AuditQueryPrincipal } from './ports.js';

const TOKENS: Readonly<Record<string, AuditQueryPrincipal | 'revoked'>> = {
  auditor: AUDITOR,
  admin: ORG_ADMIN,
  dev: principal(['developer']),
  notenant: principal(['auditor'], { tenantId: null }),
  revoked: 'revoked',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function server() {
  const h = harness();
  const app = Fastify();
  apps.push(app);
  registerAuditQueryRoutes(app, {
    service: h.service,
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

const get = (app: FastifyInstance, token: string, query = '') =>
  app.inject({
    method: 'GET',
    url: `${AUDIT_EVENTS_ROUTE}${query}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('GET /v1/audit/events', () => {
  it('answers 200 with a page, no-store, newest first', async () => {
    const { app, h } = await server();
    h.store.insert(TENANT_A, ledgerRow(1));
    h.store.insert(TENANT_A, ledgerRow(2));
    const res = await get(app, 'auditor', '?limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ items: { seq: number }[]; nextCursor?: string }>();
    expect(body.items.map((item) => item.seq)).toEqual([2]);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('answers 401 UNAUTHENTICATED for a revoked credential, and never runs the query', async () => {
    const { app, h } = await server();
    const res = await get(app, 'revoked');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(h.store.transactions).toEqual([]);
  });

  it('answers 403 FORBIDDEN problem+json for a caller without audit:read', async () => {
    const { app, h } = await server();
    const res = await get(app, 'dev');
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(h.store.transactions).toEqual([]);
  });

  it('answers 403 TENANT_CONTEXT_MISSING when the caller has no tenant', async () => {
    const { app } = await server();
    const res = await get(app, 'notenant');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_CONTEXT_MISSING' });
  });

  it('answers 400 INVALID_CURSOR for a forged cursor', async () => {
    const { app } = await server();
    const res = await get(app, 'auditor', '?cursor=forged.cursor');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
  });

  it('answers 422 VALIDATION_FAILED for a naive timestamp, with the field in detail', async () => {
    const { app } = await server();
    const res = await get(app, 'auditor', '?from=2026-10-20T10:00:00');
    expect(res.statusCode).toBe(422);
    const body = res.json<{ code: string; detail: string }>();
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.detail).toContain('from');
  });

  it('answers 422 for an unknown query key instead of ignoring it', async () => {
    const { app } = await server();
    const res = await get(app, 'auditor', '?tenantId=018f0000-0000-7000-8000-00000000000b');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers 403 for includeChain=true from a non-auditor admin', async () => {
    const { app } = await server();
    const res = await get(app, 'admin', '?includeChain=true');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });
});
