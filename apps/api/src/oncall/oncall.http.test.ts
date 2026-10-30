import { type DynamicModule, Module } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics, type HttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { OncallController } from './controller.js';
import {
  ADMIN,
  ADMIN_B,
  AUDITOR,
  MANAGER,
  PRIMARY,
  SECONDARY,
  TENANT_A,
  TENANT_B,
} from './fixtures.test-helpers.js';
import {
  InMemoryOncallAuditSink,
  InMemoryOncallExceptionReader,
  InMemoryOncallMemberships,
  InMemoryOncallStore,
} from './memory.js';
import { createOncallMetrics } from './metrics.js';
import { OncallService } from './service.js';
import { ONCALL_MEMBERSHIPS, ONCALL_SERVICE } from './tokens.js';

import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const USERS: Record<string, string> = {
  'admin-a': ADMIN,
  'auditor-a': AUDITOR,
  'admin-b': ADMIN_B,
};
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };

/**
 * Test IAM: the validated principal comes from a header the test controls. The value is `<user>@<tenant>`.
 * An unknown user or tenant resolves to a principal with no tenant, so the guard refuses it.
 */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [user, tenant] = who.split('@');
  const userId = USERS[user ?? ''];
  const tenantId = TENANTS[tenant ?? ''];
  if (userId === undefined || tenantId === undefined)
    return { actor: { type: 'user', id: 'usr_none' } };
  return { actor: { type: 'user', id: userId }, sessionTenantId: tenantId };
}

/** Mounts the controller over in-memory adapters (the Postgres ones are covered by the int test). */
@Module({})
class OncallHttpTestModule {
  static forRoot(service: OncallService, memberships: InMemoryOncallMemberships): DynamicModule {
    return {
      module: OncallHttpTestModule,
      controllers: [OncallController],
      providers: [
        { provide: ONCALL_SERVICE, useValue: service },
        { provide: ONCALL_MEMBERSHIPS, useValue: memberships },
      ],
    };
  }
}

interface OncallRosterJson {
  id: string;
  stateVersion: number;
  name: string;
}

let app: NestFastifyApplication;
let metrics: HttpMetrics;

beforeEach(async () => {
  metrics = createHttpMetrics();
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const service = new OncallService({
    store: new InMemoryOncallStore(),
    exceptions: new InMemoryOncallExceptionReader(),
    audit: new InMemoryOncallAuditSink(),
    logger,
    metrics: createOncallMetrics(metrics.registry),
  });
  const memberships = new InMemoryOncallMemberships({
    [TENANT_A]: { [ADMIN]: ['org_admin'], [AUDITOR]: ['auditor'] },
    [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
  });
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger,
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [OncallHttpTestModule.forRoot(service, memberships)],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const url = '/v1/oncall/rosters';
const as = (principal?: string) =>
  principal === undefined ? {} : { 'x-test-principal': principal };

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'Primary rotation',
  timezone: 'Europe/Berlin',
  members: [
    { userId: PRIMARY, level: 0, orderIndex: 0, channelRefs: [newId()] },
    { userId: SECONDARY, level: 1, orderIndex: 0, channelRefs: [newId()] },
    { userId: MANAGER, level: 2, orderIndex: 0 },
  ],
  ...overrides,
});

async function create(principal: string, payload: unknown = body()) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...as(principal), 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

async function patch(principal: string, id: string, payload: unknown, ifMatch?: string) {
  return app.inject({
    method: 'PATCH',
    url: `${url}/${id}`,
    headers: {
      ...as(principal),
      'content-type': 'application/json',
      ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
    },
    payload: payload as Record<string, unknown>,
  });
}

describe('POST /v1/oncall/rosters', () => {
  it('creates a roster for an Org Admin: 201, a Location, an ETag and no-store', async () => {
    const res = await create('admin-a@a');
    expect(res.statusCode).toBe(201);
    const roster = res.json<OncallRosterJson>();
    expect(res.headers.location).toBe(`${url}/${roster.id}`);
    expect(res.headers.etag).toBe('"v0"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(roster.name).toBe('Primary rotation');
  });

  it('refuses an auditor with 403 and writes nothing', async () => {
    const res = await create('auditor-a@a');
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const list = await app.inject({ method: 'GET', url, headers: as('admin-a@a') });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('answers 401 with no principal and never runs the handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a second active roster in the tenant with 409', async () => {
    await create('admin-a@a');
    const res = await create('admin-a@a', body({ name: 'Second' }));
    expect(res.statusCode).toBe(409);
  });

  it('rejects a body with an unknown field with a problem response, not a 500', async () => {
    const res = await create('admin-a@a', body({ extra: true }));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('GET /v1/oncall/rosters', () => {
  it("lists the caller tenant's rosters only", async () => {
    await create('admin-a@a');
    const own = await app.inject({ method: 'GET', url, headers: as('admin-a@a') });
    const other = await app.inject({ method: 'GET', url, headers: as('admin-b@b') });
    expect(own.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(other.json<{ items: unknown[] }>()).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /v1/oncall/rosters/:id', () => {
  it('returns the roster with its ETag, and not found for another tenant', async () => {
    const created = (await create('admin-a@a')).json<OncallRosterJson>();
    const res = await app.inject({
      method: 'GET',
      url: `${url}/${created.id}`,
      headers: as('admin-a@a'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"v0"');

    const foreign = await app.inject({
      method: 'GET',
      url: `${url}/${created.id}`,
      headers: as('admin-b@b'),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('answers not found for a malformed id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${url}/not-a-uuid`,
      headers: as('admin-a@a'),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/oncall/rosters/:id', () => {
  it('requires If-Match: 428 without it, 412 for a stale ETag, 200 with the current one', async () => {
    const created = (await create('admin-a@a')).json<OncallRosterJson>();

    const missing = await patch('admin-a@a', created.id, { name: 'Renamed' });
    expect(missing.statusCode).toBe(428);

    const stale = await patch('admin-a@a', created.id, { name: 'Renamed' }, '"v9"');
    expect(stale.statusCode).toBe(412);

    const ok = await patch('admin-a@a', created.id, { name: 'Renamed' }, '"v0"');
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"v1"');
    expect(ok.json<OncallRosterJson>().name).toBe('Renamed');
  });

  it("refuses another tenant's roster with 404 and an auditor with 403", async () => {
    const created = (await create('admin-a@a')).json<OncallRosterJson>();

    expect((await patch('admin-b@b', created.id, { name: 'x' }, '"v0"')).statusCode).toBe(404);
    expect((await patch('auditor-a@a', created.id, { name: 'x' }, '"v0"')).statusCode).toBe(403);
  });
});
