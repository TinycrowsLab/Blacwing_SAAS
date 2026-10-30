// Plan quotas against real Postgres (TENANT-009): the asset create is refused at the plan limit with problem+json,
// the refusal is audited, the TOCTOU race at the boundary admits exactly one create, counts are tenant-scoped, a plan
// change re-evaluates the limits, an unknown plan fails closed, and `GET /v1/tenant/quotas` reports used and limit.
// Needs Docker (Testcontainers); run with `pnpm --filter @blackwing/api test:int`.

import { eq } from 'drizzle-orm';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COST_PROVIDERS, COST_STAGES } from '@blackwing/contracts';
import {
  costLedger,
  createDatabase,
  memberships,
  migrateDatabase,
  publicId,
  runs,
  tenants,
  withTenant,
} from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createQuotaMetrics } from './metrics.js';
import { AssetsModule } from '../assets/module.js';
import { AssetRepository } from '../assets/repository.js';
import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { QuotaModule } from './module.js';
import { QuotaService } from './service.js';

import type { TenantPrincipal } from '@blackwing/db/tenant-context';

let handle: PostgresHandle;
let app: ApiApp;
let quota: QuotaService;

const tenantA = newId();
const tenantB = newId();
const owner = newId(); // appsec_engineer in A: creates assets
const admin = newId(); // org_admin in A: reads the quotas
const member1 = newId();
const member2 = newId();

interface Caller {
  readonly tenant: string;
  readonly user: string;
}
const OWNER: Caller = { tenant: tenantA, user: owner };
const ADMIN: Caller = { tenant: tenantA, user: admin };

const db = () => createDatabase(handle.appPool);

function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const raw = headers['x-test-caller'];
  if (typeof raw !== 'string') return null;
  const [tenant, user] = raw.split('|');
  if (tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

async function call(caller: Caller, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'x-test-caller': `${caller.tenant}|${caller.user}`,
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const assetBody = (name: string) => ({
  type: 'web_app',
  name,
  identifiers: [{ kind: 'url', value: `https://${name}.example.com` }],
  environment: 'staging',
  ownerUserId: owner,
});

/** Reads rows as the app role with the tenant set for the transaction only (RLS enforced). */
async function queryAs<T>(tenant: string, text: string, values: unknown[] = []): Promise<T[]> {
  const client = await handle.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await client.query(text, values);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedUser(id: string): Promise<void> {
  await handle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [id, `sub-${id}`, `${id}@test.invalid`, 'test user'],
  );
}

async function seedMember(tenantId: string, userId: string, roles: string[]): Promise<void> {
  await withTenant(db(), tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId, roles }),
  );
}

/** Inserts an asset row as the app role, bypassing the HTTP layer (used to fill a plan to its limit). */
async function seedAsset(tenantId: string, name: string): Promise<void> {
  const id = newId();
  await withTenant(db(), tenantId, (tx) =>
    new AssetRepository({ db: db() }).insert(tx, tenantId, {
      id,
      publicId: publicId('asset', id),
      type: 'web_app',
      name,
      identifiers: [{ kind: 'url', value: `https://${name}.example.com` }],
      environment: 'staging',
      ownerUserId: owner,
      idempotencyKey: null,
      idempotencyFingerprint: null,
    }),
  );
}

/** Changes a tenant's plan as the app role, inside its tenant context (the platform plan path is out of scope). */
async function setPlan(tenantId: string, plan: string): Promise<void> {
  await withTenant(db(), tenantId, (tx) =>
    tx.update(tenants).set({ plan }).where(eq(tenants.id, tenantId)),
  );
}

/** Writes platform reference data (`price_tables`) as the operator role, as the cost suite does. */
async function asOperator(text: string, values: unknown[]): Promise<void> {
  const client = await handle.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bw_operator');
    await client.query(text, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assetCount(tenantId: string): Promise<number> {
  const rows = await queryAs<{ n: number }>(
    tenantId,
    'SELECT count(*)::int AS n FROM assets WHERE deleted_at IS NULL',
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (o) => migrateDatabase(o) });
  await withTenant(db(), tenantA, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantA, slug: 'acme-quota', name: 'Acme', region: 'eu-west-1' }),
  );
  await withTenant(db(), tenantB, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantB, slug: 'beta-quota', name: 'Beta', region: 'eu-west-1' }),
  );
  for (const user of [owner, admin, member1, member2]) await seedUser(user);
  await seedMember(tenantA, owner, ['appsec_engineer']);
  await seedMember(tenantA, admin, ['org_admin']);

  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  // The shared service the assets module enforces through. Its metrics live on a private registry: the app's
  // registry already carries the counter through QuotaModule, and a metric name can be registered only once.
  quota = new QuotaService({
    database: db(),
    metrics: createQuotaMetrics(new Registry()),
    logger,
  });
  const config = loadApiConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_DEFAULT_RPS: '1000',
    RATE_LIMIT_BURST: '100000',
  });
  app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers),
    imports: [
      AssetsModule.forRoot({
        database: db(),
        registry: metrics.registry,
        quota,
        // The quota suite never creates a credential: any use of the vault is a bug.
        credentialVault: {
          seal: () => Promise.reject(new Error('credential vault is not used by the quota suite')),
          rotate: () =>
            Promise.reject(new Error('credential vault is not used by the quota suite')),
        },
      }),
      QuotaModule.forRoot({ database: db(), registry: metrics.registry, logger }),
    ],
  });
  await app.app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.app.close();
  await handle.stop();
});

describe('POST /v1/assets against the plan limit', () => {
  // Wire codes are snake_case (`quota_exceeded`), like every registry code; the stable name is QUOTA_EXCEEDED.
  it('admits creates under the free limit and refuses the one past it with 409 quota_exceeded', async () => {
    // The free plan allows 3 assets (PLAN_CATALOGUE.free). The tenant starts on `free` by default.
    for (const name of ['first', 'second', 'third']) {
      const res = await call(OWNER, 'POST', '/v1/assets', assetBody(name));
      expect(res.statusCode).toBe(201);
    }
    const refused = await call(OWNER, 'POST', '/v1/assets', assetBody('fourth'));
    expect(refused.statusCode).toBe(409);
    expect(refused.headers['content-type']).toContain('application/problem+json');
    const problem = refused.json<{ status: number; code: string; detail: string }>();
    expect(problem).toMatchObject({ status: 409, code: 'quota_exceeded' });
    expect(problem.detail).toContain('allows 3 assets; this tenant has 3');
    expect(await assetCount(tenantA)).toBe(3);
  });

  it('writes a tenant.quota_exceeded audit event that survives the refusal', async () => {
    const rows = await queryAs<{ action: string; metadata: Record<string, unknown> }>(
      tenantA,
      "SELECT action, metadata FROM audit_events WHERE action = 'tenant.quota_exceeded'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.metadata).toMatchObject({
      resource: 'assets',
      plan: 'free',
      limit: 3,
      used: 3,
    });
  });

  it('a plan change re-evaluates the limit: upgrading admits the create', async () => {
    await setPlan(tenantA, 'pro');
    const res = await call(OWNER, 'POST', '/v1/assets', assetBody('after-upgrade'));
    expect(res.statusCode).toBe(201);
    expect(await assetCount(tenantA)).toBe(4);
  });

  it('a downgrade below current usage keeps existing assets and blocks new creates', async () => {
    await setPlan(tenantA, 'free');
    expect(await assetCount(tenantA)).toBe(4);
    const res = await call(OWNER, 'POST', '/v1/assets', assetBody('after-downgrade'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'quota_exceeded' });
    expect(await assetCount(tenantA)).toBe(4);
  });

  it('fails closed on an unknown plan: 500, and nothing is created', async () => {
    await setPlan(tenantA, 'gold');
    const res = await call(OWNER, 'POST', '/v1/assets', assetBody('unknown-plan'));
    expect(res.statusCode).toBe(500);
    expect(await assetCount(tenantA)).toBe(4);
    await setPlan(tenantA, 'enterprise');
  });
});

describe('quota counting is tenant-scoped and race-safe', () => {
  it('counts only the caller tenant: another tenant at its limit does not block this one', async () => {
    // Tenant B fills its free limit (3 of 3). A fresh free tenant C, with the same owner as a member, must still create.
    await setPlan(tenantB, 'free');
    for (const name of ['b1', 'b2', 'b3']) await seedAsset(tenantB, name);
    expect(await assetCount(tenantB)).toBe(3);
    const tenantC = newId();
    await withTenant(db(), tenantC, (tx) =>
      tx
        .insert(tenants)
        .values({ id: tenantC, slug: 'gamma-quota', name: 'Gamma', region: 'eu-west-1' }),
    );
    await withTenant(db(), tenantC, (tx) =>
      tx
        .insert(memberships)
        .values({ tenantId: tenantC, userId: owner, roles: ['appsec_engineer'] }),
    );
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: { 'content-type': 'application/json', 'x-test-caller': `${tenantC}|${owner}` },
      payload: assetBody('isolation-check'),
    });
    expect(res.statusCode).toBe(201);
    expect(await assetCount(tenantC)).toBe(1);
  });

  it('two concurrent creates racing for the last free slot admit exactly one', async () => {
    const racing = newId();
    await withTenant(db(), racing, (tx) =>
      tx.insert(tenants).values({
        id: racing,
        slug: 'race-quota',
        name: 'Race',
        region: 'eu-west-1',
        plan: 'free',
      }),
    );
    const raceUser = newId();
    await seedUser(raceUser);
    await withTenant(db(), racing, (tx) =>
      tx
        .insert(memberships)
        .values({ tenantId: racing, userId: raceUser, roles: ['appsec_engineer'] }),
    );
    await seedAsset(racing, 'r1');
    await seedAsset(racing, 'r2');

    const attempt = async (name: string) =>
      withTenant(db(), racing, async (tx) => {
        const denial = await quota.enforceInTx(
          tx,
          { tenantId: racing, userId: raceUser },
          'assets',
        );
        if (denial !== undefined) return 'denied' as const;
        const id = newId();
        await new AssetRepository({ db: db() }).insert(tx, racing, {
          id,
          publicId: publicId('asset', id),
          type: 'web_app',
          name,
          identifiers: [{ kind: 'url', value: `https://${name}.example.com` }],
          environment: 'staging',
          ownerUserId: raceUser,
          idempotencyKey: null,
          idempotencyFingerprint: null,
        });
        return 'created' as const;
      });

    const outcomes = await Promise.all([attempt('race-a'), attempt('race-b')]);
    expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'denied')).toHaveLength(1);
    expect(await assetCount(racing)).toBe(3);
  });
});

describe('other resources', () => {
  it('counts members, and refuses the one past the free limit', async () => {
    const fresh = newId();
    await withTenant(db(), fresh, (tx) =>
      tx
        .insert(tenants)
        .values({ id: fresh, slug: 'members-quota', name: 'M', region: 'eu-west-1' }),
    );
    const extra = newId();
    await seedUser(extra);
    for (const user of [member1, member2, extra]) {
      await withTenant(db(), fresh, (tx) =>
        tx.insert(memberships).values({ tenantId: fresh, userId: user, roles: [] }),
      );
    }
    // Three memberships on a free tenant (limit 3): a fourth seat is refused.
    const denial = await withTenant(db(), fresh, (tx) =>
      quota.enforceInTx(tx, { tenantId: fresh, userId: member1 }, 'members'),
    );
    expect(denial?.resource).toBe('members');
    expect(denial?.decision).toMatchObject({ allowed: false, limit: 3, used: 3 });
  });

  it('counts only non-terminal runs toward concurrency', async () => {
    const fresh = newId();
    await withTenant(db(), fresh, (tx) =>
      tx.insert(tenants).values({ id: fresh, slug: 'runs-quota', name: 'R', region: 'eu-west-1' }),
    );
    const userId = newId();
    await seedUser(userId);
    await withTenant(db(), fresh, async (tx) => {
      await tx.insert(runs).values({ tenantId: fresh, state: 'completed' });
      await tx.insert(runs).values({ tenantId: fresh, state: 'failed' });
    });
    const allowed = await withTenant(db(), fresh, (tx) =>
      quota.enforceInTx(tx, { tenantId: fresh, userId }, 'concurrent_runs'),
    );
    expect(allowed).toBeUndefined();
    await withTenant(db(), fresh, (tx) =>
      tx.insert(runs).values({ tenantId: fresh, state: 'executing' }),
    );
    const denied = await withTenant(db(), fresh, (tx) =>
      quota.enforceInTx(tx, { tenantId: fresh, userId }, 'concurrent_runs'),
    );
    expect(denied?.decision).toMatchObject({ allowed: false, limit: 1, used: 1 });
  });

  it('refuses a create once month-to-date cost reaches the monthly cap', async () => {
    const fresh = newId();
    await withTenant(db(), fresh, (tx) =>
      tx.insert(tenants).values({ id: fresh, slug: 'cost-quota', name: 'C', region: 'eu-west-1' }),
    );
    const userId = newId();
    await seedUser(userId);
    const priceTableId = newId();
    await asOperator(
      `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
         cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
       VALUES ($1, $2, 'quota-test-model', 1, 1, 1, 1, 1, now(), $3)`,
      [priceTableId, COST_PROVIDERS[0], 'a'.repeat(64)],
    );
    const spend = async (cost: string) =>
      withTenant(db(), fresh, (tx) =>
        tx.insert(costLedger).values({
          tenantId: fresh,
          runId: newId(),
          stage: COST_STAGES[0],
          provider: COST_PROVIDERS[0],
          model: 'quota-test-model',
          priceTableId,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: cost,
          usageEventId: `evt-${newId()}`,
          occurredAt: new Date(),
        }),
      );
    await spend('49.99');
    const under = await withTenant(db(), fresh, (tx) =>
      quota.enforceInTx(tx, { tenantId: fresh, userId }, 'monthly_cost'),
    );
    expect(under).toBeUndefined();
    await spend('0.01');
    const capped = await withTenant(db(), fresh, (tx) =>
      quota.enforceInTx(tx, { tenantId: fresh, userId }, 'monthly_cost'),
    );
    expect(capped?.resource).toBe('monthly_cost');
    expect(capped?.decision).toMatchObject({ allowed: false, limit: 50 });
  });
});

describe('GET /v1/tenant/quotas', () => {
  it('reports used and limit per resource for an org admin', async () => {
    const res = await call(ADMIN, 'GET', '/v1/tenant/quotas');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{
      plan: string;
      assets: { used: number; limit: number | null };
      concurrentRuns: { used: number; limit: number | null };
      members: { used: number; limit: number | null };
      monthlyCostUsd: {
        used: number;
        limit: number | null;
        periodStart: string;
        periodEnd: string;
      };
    }>();
    expect(body.plan).toBe('enterprise');
    expect(body.assets).toEqual({ used: await assetCount(tenantA), limit: null });
    expect(body.members).toEqual({ used: 2, limit: null });
    expect(body.concurrentRuns).toEqual({ used: 0, limit: null });
    expect(body.monthlyCostUsd.limit).toBeNull();
    expect(body.monthlyCostUsd.periodStart.endsWith('-01T00:00:00.000Z')).toBe(true);
  });

  it('refuses a member whose role does not grant settings:read', async () => {
    const res = await call(OWNER, 'GET', '/v1/tenant/quotas');
    expect(res.statusCode).toBe(403);
  });

  it('is tenant-scoped: the view counts only the caller tenant', async () => {
    const view = await quota.view({ tenantId: tenantA, userId: admin });
    expect(view.assets.used).toBe(await assetCount(tenantA));
    expect(view.assets.used).not.toBe(await assetCount(tenantB));
  });
});
