// GraphQL member reads against real Postgres (API-009): RLS confines `memberships` to the caller's tenant, a
// user is visible only through a membership of that tenant, and a request without a tenant fails closed. Needs
// Docker (Testcontainers); run with `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, memberships, migrateDatabase, tenants, withTenant } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';
import { createPgMemberReadStore } from './postgres.js';

import type { TenantPrincipal } from '@blackwing/db/tenant-context';

let handle: PostgresHandle;
const tenantA = newId();
const tenantB = newId();
const userA1 = newId();
const userA2 = newId();
const userB1 = newId();

async function seedTenant(id: string, slug: string): Promise<void> {
  const orm = createDatabase(handle.appPool);
  await withTenant(orm, id, (tx) =>
    tx.insert(tenants).values({ id, slug, name: slug, region: 'eu-west-1' }),
  );
}

async function seedUser(id: string, email: string): Promise<void> {
  await handle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [id, `sub-${id}`, email, email.split('@')[0] ?? null],
  );
}

async function seedMembership(tenantId: string, userId: string, roles: string[]): Promise<void> {
  await withTenant(createDatabase(handle.appPool), tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId, roles }),
  );
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await seedTenant(tenantA, 'acme-graphql');
  await seedTenant(tenantB, 'beta-graphql');
  await seedUser(userA1, 'ada@acme.test');
  await seedUser(userA2, 'ben@acme.test');
  await seedUser(userB1, 'bea@beta.test');
  await seedMembership(tenantA, userA1, ['admin']);
  await seedMembership(tenantA, userA2, ['viewer']);
  await seedMembership(tenantB, userB1, ['viewer']);
});

afterAll(async () => {
  await handle.stop();
});

describe('GraphQL member store over Postgres (RLS)', () => {
  it("lists only the caller tenant's memberships", async () => {
    const store = createPgMemberReadStore(createDatabase(handle.appPool));
    const rows = await store.listMembers(tenantA, 50);
    expect(rows.map((row) => row.userId).sort()).toEqual([userA1, userA2].sort());
    expect(rows.map((row) => row.userId)).not.toContain(userB1);
  });

  it('resolves a user only through a membership of the same tenant', async () => {
    const store = createPgMemberReadStore(createDatabase(handle.appPool));
    const own = await store.findUsers(tenantA, [userA1, userB1]);
    expect([...own.keys()]).toEqual([userA1]);
    const foreign = await store.findUsers(tenantB, [userA1]);
    expect(foreign.size).toBe(0);
  });

  it('fails closed without a valid tenant id', async () => {
    const store = createPgMemberReadStore(createDatabase(handle.appPool));
    await expect(store.listMembers('not-a-tenant', 5)).rejects.toThrow();
    await expect(store.findUsers('', [userA1])).rejects.toThrow();
  });
});

describe('GraphQL endpoint over Postgres (RLS)', () => {
  let app: ApiApp | undefined;

  afterAll(async () => {
    await app?.app.close();
  });

  it('answers a caller only with its own tenant rows, users included', async () => {
    const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
    const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
    const metrics = createHttpMetrics();
    const store = createPgMemberReadStore(createDatabase(handle.appPool));
    app = await createApiApp({
      config,
      logger,
      metrics,
      tenantPrincipalSource: (request) => {
        const header = request.headers['x-test-tenant'];
        if (header !== tenantA && header !== tenantB) return null;
        const principal: TenantPrincipal = {
          actor: { type: 'user', id: 'usr_int' },
          sessionTenantId: header,
        };
        return principal;
      },
      imports: [GraphqlApiModule.forRoot({ config, logger, metrics, store })],
    });
    await app.app.getHttpAdapter().getInstance().ready();
    const res = await app.app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json', 'x-test-tenant': tenantB },
      payload: { query: '{ tenantMembers { userId user { email } } }' },
    });
    const body = res.json<{
      data: { tenantMembers: { userId: string; user: { email: string } | null }[] };
    }>();
    expect(body.data.tenantMembers).toEqual([{ userId: userB1, user: { email: 'bea@beta.test' } }]);
    expect(res.body).not.toMatch(/acme\.test/);
  });
});
