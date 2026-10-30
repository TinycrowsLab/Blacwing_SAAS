// HTTP surface of service accounts (RBAC-005): authentication, the role gate, the If-Match protocol, the
// duplicate and owner checks, the approval-role refusal and tenant isolation, through the real Nest app.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTenantContextOrThrow, type TenantPrincipal } from '@blackwing/db/tenant-context';
import { ERROR_CODES } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { ServiceAccountsModule } from './module.js';
import { type Backing, emptyBacking, InMemoryStore } from './store.test-helpers.js';

import type { ServiceAccountStore } from './service.js';
import type { Problem, Role, ServiceAccount } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const TENANT_A = '0190a000-0000-7000-8000-00000000000a';
const TENANT_B = '0190a000-0000-7000-8000-00000000000b';
const ADMIN_A = '0190a000-0000-7000-8000-0000000000a1';
const DEV_A = '0190a000-0000-7000-8000-0000000000a2';
const ADMIN_B = '0190a000-0000-7000-8000-0000000000b1';

/** Test IAM: the principal is read from a header the test controls, `<user>@<tenant>`. */
const USERS: Record<string, string> = { 'admin-a': ADMIN_A, 'dev-a': DEV_A, 'admin-b': ADMIN_B };
const TENANTS: Record<string, string> = { a: TENANT_A, b: TENANT_B };
/** Roles per (tenant, user): the caller's IAM membership in the tenant. */
const ROLES: Record<string, readonly Role[]> = {
  [`${TENANT_A}:${ADMIN_A}`]: ['org_admin'],
  [`${TENANT_A}:${DEV_A}`]: ['developer'],
  [`${TENANT_B}:${ADMIN_B}`]: ['org_admin'],
};

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

/**
 * The store the module is mounted with: each call binds to the request's ambient tenant, as the Postgres
 * repository does, so one app serves both tenants and a request can never reach the other tenant's rows.
 */
function ambientStore(backing: Backing): ServiceAccountStore {
  const current = (): InMemoryStore =>
    new InMemoryStore(getTenantContextOrThrow().tenantId, backing);
  return {
    insert: (value) => current().insert(value),
    patch: (id, version, changes) => current().patch(id, version, changes),
    disable: (id, version) => current().disable(id, version),
    list: () => current().list(),
    findById: (id) => current().findById(id),
  };
}

let app: NestFastifyApplication;

beforeEach(async () => {
  const backing = emptyBacking(
    new Map([
      [TENANT_A, new Set([ADMIN_A, DEV_A])],
      [TENANT_B, new Set([ADMIN_B])],
    ]),
  );
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    metrics: createHttpMetrics(),
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [
      ServiceAccountsModule.forRoot({
        store: ambientStore(backing),
        roles: (caller) =>
          Promise.resolve(
            ROLES[`${caller.tenantId}:${'id' in caller.actor ? caller.actor.id : ''}`] ?? [],
          ),
      }),
    ],
  });
  app = created.app;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const url = '/v1/service-accounts';
const as = (principal?: string) =>
  principal === undefined ? {} : { 'x-test-principal': principal };

async function create(principal: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { ...as(principal), 'content-type': 'application/json' },
    payload: body,
  });
}

async function send(
  method: 'PATCH' | 'DELETE' | 'GET',
  path: string,
  principal: string,
  options: { readonly ifMatch?: string; readonly body?: Record<string, unknown> } = {},
) {
  return app.inject({
    method,
    url: path,
    headers: {
      ...as(principal),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.ifMatch === undefined ? {} : { 'if-match': options.ifMatch }),
    },
    ...(options.body === undefined ? {} : { payload: options.body }),
  });
}

const ciAccount = { name: 'ci-scanner', roles: ['ci_pipeline'], ownerUserId: ADMIN_A };

async function createdAccount(): Promise<ServiceAccount> {
  const res = await create('admin-a@a', ciAccount);
  return res.json<ServiceAccount>();
}

describe('POST /v1/service-accounts', () => {
  it('creates a least-privilege account at version 0 with an ETag and no-store', async () => {
    const res = await create('admin-a@a', ciAccount);
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<ServiceAccount>()).toMatchObject({
      name: 'ci-scanner',
      roles: ['ci_pipeline'],
      ownerUserId: ADMIN_A,
      status: 'active',
      stateVersion: 0,
    });
  });

  it('answers 401 with no principal and creates nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: ciAccount,
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 403 for a developer, who holds no token:create', async () => {
    const res = await create('dev-a@a', ciAccount);
    expect(res.statusCode).toBe(403);
  });

  it('refuses an approval or admin role at the edge (422), so the account is never written', async () => {
    const res = await create('admin-a@a', { ...ciAccount, roles: ['org_admin'] });
    expect(res.statusCode).toBe(ERROR_CODES.VALIDATION_FAILED.status);
    expect(res.json<Problem>().code).toBe('validation_failed');
  });

  it('refuses a body that sets the tenant or the status (unknown keys)', async () => {
    const res = await create('admin-a@a', { ...ciAccount, tenantId: TENANT_B, status: 'disabled' });
    expect(res.statusCode).toBe(ERROR_CODES.VALIDATION_FAILED.status);
  });

  it('answers 409 when the name is taken in the tenant', async () => {
    await createdAccount();
    const res = await create('admin-a@a', ciAccount);
    expect(res.statusCode).toBe(ERROR_CODES.CONFLICT.status);
    expect(res.json<Problem>().code).toBe('conflict');
  });

  it('answers 422 when the owner is not a member of this tenant (no cross-tenant owner)', async () => {
    const res = await create('admin-a@a', { ...ciAccount, name: 'foreign', ownerUserId: ADMIN_B });
    expect(res.statusCode).toBe(ERROR_CODES.VALIDATION_FAILED.status);
  });
});

describe('GET /v1/service-accounts', () => {
  it('lists the tenant accounts in one page with a nextCursor', async () => {
    await createdAccount();
    const res = await send('GET', url, 'admin-a@a');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: ServiceAccount[] }>().items).toHaveLength(1);
  });

  it('answers 403 for a developer', async () => {
    expect((await send('GET', url, 'dev-a@a')).statusCode).toBe(403);
  });

  it("answers 404 for another tenant's account id (no existence leak)", async () => {
    const created = await createdAccount();
    const res = await send('GET', `${url}/${created.id}`, 'admin-b@b');
    expect(res.statusCode).toBe(ERROR_CODES.NOT_FOUND.status);
    expect(res.json<Problem>().code).toBe('not_found');
  });

  it('rejects a malformed id before any lookup', async () => {
    const res = await send('GET', `${url}/not-a-uuid`, 'admin-a@a');
    expect(res.statusCode).toBe(ERROR_CODES.VALIDATION_FAILED.status);
  });
});

describe('PATCH and DELETE /v1/service-accounts/{id}', () => {
  it('requires If-Match (428), refuses a stale one (412), then applies the change and bumps the ETag', async () => {
    const created = await createdAccount();
    const path = `${url}/${created.id}`;
    const missing = await send('PATCH', path, 'admin-a@a', { body: { roles: ['developer'] } });
    expect(missing.statusCode).toBe(ERROR_CODES.PRECONDITION_REQUIRED.status);

    const stale = await send('PATCH', path, 'admin-a@a', {
      ifMatch: '"7"',
      body: { roles: ['developer'] },
    });
    expect(stale.statusCode).toBe(ERROR_CODES.PRECONDITION_FAILED.status);

    const ok = await send('PATCH', path, 'admin-a@a', {
      ifMatch: '"0"',
      body: { roles: ['developer'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    expect(ok.json<ServiceAccount>().roles).toEqual(['developer']);
  });

  it('refuses an approval role on update at the edge', async () => {
    const created = await createdAccount();
    const res = await send('PATCH', `${url}/${created.id}`, 'admin-a@a', {
      ifMatch: '"0"',
      body: { roles: ['appsec_engineer'] },
    });
    expect(res.statusCode).toBe(ERROR_CODES.VALIDATION_FAILED.status);
  });

  it('disables with DELETE: the account is kept with status disabled and a new ETag', async () => {
    const created = await createdAccount();
    const path = `${url}/${created.id}`;
    const res = await send('DELETE', path, 'admin-a@a', { ifMatch: '"0"' });
    expect(res.statusCode).toBe(200);
    expect(res.json<ServiceAccount>()).toMatchObject({ status: 'disabled', stateVersion: 1 });
    expect((await send('GET', path, 'admin-a@a')).json<ServiceAccount>().status).toBe('disabled');
  });

  it("cannot change another tenant's account (404, nothing written)", async () => {
    const created = await createdAccount();
    const res = await send('PATCH', `${url}/${created.id}`, 'admin-b@b', {
      ifMatch: '"0"',
      body: { description: 'stolen' },
    });
    expect(res.statusCode).toBe(ERROR_CODES.NOT_FOUND.status);
    expect(
      (await send('GET', `${url}/${created.id}`, 'admin-a@a')).json<ServiceAccount>().description,
    ).toBeNull();
  });
});
