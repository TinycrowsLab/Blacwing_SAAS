// Asset REST API against real Postgres (ASSET-002, #355): the five routes end to end through the NestJS app
// with the tenant guard, RBAC plus Cedar, RLS, optimistic concurrency, idempotent create and the audit chain.
// Needs Docker (Testcontainers); run with `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assetListResponseSchema } from '@blackwing/contracts';
import {
  createDatabase,
  memberships,
  migrateDatabase,
  publicId,
  standingAuthorisations,
  tenants,
  withTenant,
} from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { createLogger } from '@blackwing/logger';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { AssetsModule } from './module.js';

import type { TenantPrincipal } from '@blackwing/db/tenant-context';

let handle: PostgresHandle;
let app: ApiApp;

const tenantA = newId();
const tenantB = newId();
const alice = newId(); // appsec_engineer in A
const bob = newId(); // asset_owner in A
const carol = newId(); // auditor in A (read only)
const eve = newId(); // appsec_engineer in B
const mallory = newId(); // not a member anywhere
const nora = newId(); // a member of A with no roles at all

interface Caller {
  readonly tenant: string;
  readonly user: string;
}
const as = (caller: Caller) => ({ 'x-test-caller': `${caller.tenant}|${caller.user}` });
const ALICE: Caller = { tenant: tenantA, user: alice };
const BOB: Caller = { tenant: tenantA, user: bob };
const CAROL: Caller = { tenant: tenantA, user: carol };
const EVE: Caller = { tenant: tenantB, user: eve };
const MALLORY: Caller = { tenant: tenantA, user: mallory };
const NOROLE: Caller = { tenant: tenantA, user: nora };

const db = () => createDatabase(handle.appPool);

/**
 * Reads tenant rows as the app role (RLS enforced), with the tenant set for the transaction only. The owner
 * role is subject to FORCE RLS too, so it is not used for tenant data.
 */
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

/** Callers are identified by a header the test controls; the real principal source is IAM's (outside this issue). */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const raw = headers['x-test-caller'];
  if (typeof raw !== 'string') return null;
  const [tenant, user] = raw.split('|');
  if (tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

async function call(
  caller: Caller | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
) {
  const hasBody = options.payload !== undefined;
  return app.app.inject({
    method,
    url,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(caller === undefined ? {} : as(caller)),
      ...(options.headers ?? {}),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

const body = (overrides: Record<string, unknown> = {}) => ({
  type: 'web_app',
  name: 'Customer portal',
  identifiers: [{ kind: 'url', value: 'https://portal.example.com' }],
  environment: 'staging',
  ownerUserId: alice,
  ...overrides,
});

async function createAs(caller: Caller, overrides: Record<string, unknown> = {}) {
  const res = await call(caller, 'POST', '/v1/assets', { payload: body(overrides) });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; etag: string; ownerUserId: string; name: string }>();
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await withTenant(db(), tenantA, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantA, slug: 'acme-assets', name: 'Acme', region: 'eu-west-1' }),
  );
  await withTenant(db(), tenantB, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantB, slug: 'beta-assets', name: 'Beta', region: 'eu-west-1' }),
  );
  for (const user of [alice, bob, carol, eve, mallory, nora]) await seedUser(user);
  await seedMember(tenantA, alice, ['appsec_engineer']);
  await seedMember(tenantA, bob, ['asset_owner']);
  await seedMember(tenantA, carol, ['auditor']);
  await seedMember(tenantB, eve, ['appsec_engineer']);
  await seedMember(tenantA, nora, []);

  // The shared rate limit is 10 requests per second by default; this suite issues many in a burst, so the test
  // config raises it. Rate limiting has its own coverage.
  const config = loadApiConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_DEFAULT_RPS: '1000',
    RATE_LIMIT_BURST: '100000',
  });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers),
    imports: [AssetsModule.forRoot({ database: db(), registry: metrics.registry })],
  });
  await app.app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.app.close();
  await handle.stop();
});

describe('POST /v1/assets', () => {
  it('registers an asset: 201, public id, unverified, normalised identifiers, ETag and Location', async () => {
    const res = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({ identifiers: [{ kind: 'url', value: 'HTTPS://Portal.Example.com:443/#x' }] }),
    });
    expect(res.statusCode).toBe(201);
    const view = res.json<Record<string, unknown>>();
    expect(view).toMatchObject({
      type: 'web_app',
      name: 'Customer portal',
      environment: 'staging',
      ownerUserId: alice,
      verificationStatus: 'unverified',
      verificationMethod: null,
      etag: '"v0"',
      identifiers: [{ kind: 'url', value: 'https://portal.example.com/' }],
      warnings: [],
    });
    expect(view.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(view.publicId).toMatch(/^asset_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(res.headers.etag).toBe('"v0"');
    expect(res.headers.location).toBe(`/v1/assets/${String(view.id)}`);
    expect(res.body).not.toContain('"tenantId"');
  });

  it('dedupes identifiers after normalisation and reports a warning', async () => {
    const res = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({
        identifiers: [
          { kind: 'url', value: 'https://dup.example.com/' },
          { kind: 'url', value: 'https://DUP.example.com' },
        ],
      }),
    });
    expect(res.statusCode).toBe(201);
    const view = res.json<{ identifiers: unknown[]; warnings: string[] }>();
    expect(view.identifiers).toHaveLength(1);
    expect(view.warnings).toEqual(['1 duplicate identifier(s) removed after normalisation']);
  });

  it('refuses an identifier that embeds credentials, 422, without echoing the secret', async () => {
    const secret = 'pw-DO-NOT-ECHO-91';
    const res = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({
        identifiers: [{ kind: 'url', value: `https://svc:${secret}@portal.example.com/` }],
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('asset_invalid_identifier');
    expect(res.body).not.toContain(secret);
  });

  it('refuses an identifier kind that does not fit the asset type', async () => {
    const res = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({
        type: 'host',
        identifiers: [{ kind: 'url', value: 'https://a.example.com' }],
      }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('asset_invalid_identifier');
  });

  it('refuses an empty identifier list and an unknown field, 422', async () => {
    expect(
      (await call(ALICE, 'POST', '/v1/assets', { payload: body({ identifiers: [] }) })).statusCode,
    ).toBe(422);
    const extra = await call(ALICE, 'POST', '/v1/assets', { payload: body({ tenantId: tenantB }) });
    expect(extra.statusCode).toBe(422);
  });

  it('refuses an owner who is not a member of the tenant (no cross-tenant owner), 422', async () => {
    const res = await call(ALICE, 'POST', '/v1/assets', { payload: body({ ownerUserId: eve }) });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('validation_failed');
  });

  it('refuses an unauthenticated caller with 401, and a non-member with 403', async () => {
    expect((await call(undefined, 'POST', '/v1/assets', { payload: body() })).statusCode).toBe(401);
    const res = await call(MALLORY, 'POST', '/v1/assets', { payload: body() });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a caller whose role cannot write assets (auditor), 403', async () => {
    const res = await call(CAROL, 'POST', '/v1/assets', { payload: body() });
    expect(res.statusCode).toBe(403);
  });

  it('replays an Idempotency-Key with the same body as the same asset; a different body is 422', async () => {
    const key = `idem-${newId()}`;
    const first = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({ name: 'Idempotent' }),
      headers: { 'idempotency-key': key },
    });
    expect(first.statusCode).toBe(201);
    const replay = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({ name: 'Idempotent' }),
      headers: { 'idempotency-key': key },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    const other = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({ name: 'Different body' }),
      headers: { 'idempotency-key': key },
    });
    expect(other.statusCode).toBe(422);
    expect(other.json<{ code: string }>().code).toBe('idempotency_key_mismatch');
  });

  it('refuses an oversized body with 413', async () => {
    const res = await call(ALICE, 'POST', '/v1/assets', {
      payload: body({ name: 'x'.repeat(2_000_000) }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /v1/assets/:id and the list', () => {
  it('reads an asset with its ETag, and a same-tenant reader with asset:read sees it', async () => {
    const created = await createAs(ALICE);
    const res = await call(CAROL, 'GET', `/v1/assets/${created.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"v0"');
    expect(res.json<{ id: string }>().id).toBe(created.id);
  });

  it("answers 404 for another tenant's asset, and for a malformed id (never 403)", async () => {
    const created = await createAs(ALICE);
    expect((await call(EVE, 'GET', `/v1/assets/${created.id}`)).statusCode).toBe(404);
    expect((await call(ALICE, 'GET', '/v1/assets/not-an-id')).statusCode).toBe(404);
  });

  it('pages newest first with a cursor and returns every row once', async () => {
    const seeded = [];
    for (let index = 0; index < 3; index += 1) {
      seeded.push((await createAs(BOB, { name: `paged-${String(index)}` })).id);
    }
    const first = await call(BOB, 'GET', '/v1/assets?limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{
      items: { id: string }[];
      nextCursor: string | null;
      hasMore: boolean;
    }>();
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const second = await call(
      BOB,
      'GET',
      `/v1/assets?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    );
    const page2 = second.json<{
      items: { id: string }[];
      hasMore: boolean;
      nextCursor: string | null;
    }>();
    const ids = [...page1.items, ...page2.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of seeded) expect(ids).toContain(id);
    expect(!page2.hasMore || page2.nextCursor !== null).toBe(true);
  });

  it("lists only the caller's tenant, filters by type, and rejects a bad cursor", async () => {
    const own = await createAs(ALICE, {
      type: 'host',
      identifiers: [{ kind: 'host', value: 'listed.example.com' }],
    });
    const b = await call(EVE, 'GET', '/v1/assets?limit=200');
    expect(b.statusCode).toBe(200);
    expect(b.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(
      own.id,
    );
    const aItems = (await call(ALICE, 'GET', '/v1/assets?type=host&limit=200')).json<{
      items: { type: string; id: string }[];
    }>().items;
    expect(aItems.map((item) => item.id)).toContain(own.id);
    expect(aItems.every((item) => item.type === 'host')).toBe(true);
    expect((await call(ALICE, 'GET', '/v1/assets?cursor=%%%bad')).statusCode).toBe(422);
    expect((await call(ALICE, 'GET', '/v1/assets?limit=0')).statusCode).toBe(422);
    expect((await call(ALICE, 'GET', '/v1/assets?owner=x')).statusCode).toBe(422);
  });

  it('answers the wizard projection only (no identifiers, no public id) and is never cached', async () => {
    await createAs(ALICE, { name: 'projection-check' });
    const res = await call(ALICE, 'GET', '/v1/assets?limit=5');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<{ items: Record<string, unknown>[] }>();
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'environment',
        'id',
        'name',
        'type',
        'verificationStatus',
      ]);
      expect(res.body).not.toContain('identifiers');
    }
    expect(assetListResponseSchema.safeParse(body).success).toBe(true);
  });

  it('filters by verification state: the wizard asks for verified assets only', async () => {
    const unverified = await createAs(ALICE, { name: 'still-unverified' });
    const verified = await call(ALICE, 'GET', '/v1/assets?verificationStatus=verified&limit=200');
    const ids = verified.json<{ items: { id: string; verificationStatus: string }[] }>().items;
    expect(ids.every((item) => item.verificationStatus === 'verified')).toBe(true);
    expect(ids.map((item) => item.id)).not.toContain(unverified.id);
  });

  it('refuses a caller whose roles grant no asset:read, 403, and names no asset', async () => {
    const res = await call(NOROLE, 'GET', '/v1/assets');
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('Customer portal');
  });
});

describe('PATCH /v1/assets/:id (optimistic concurrency)', () => {
  it('requires If-Match: 428 without it', async () => {
    const created = await createAs(ALICE);
    const res = await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, { payload: { name: 'x' } });
    expect(res.statusCode).toBe(428);
    expect(res.json<{ code: string }>().code).toBe('precondition_required');
  });

  it('answers 409 ASSET_STALE_WRITE for a stale ETag and does not change the asset', async () => {
    const created = await createAs(ALICE);
    const res = await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
      payload: { name: 'stale' },
      headers: { 'if-match': '"v9"' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('asset_stale_write');
    expect(
      (await call(ALICE, 'GET', `/v1/assets/${created.id}`)).json<{ name: string }>().name,
    ).toBe('Customer portal');
  });

  it('updates with the current ETag: 200, a new version, and an asset.updated audit event', async () => {
    const created = await createAs(ALICE);
    const res = await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
      payload: { name: 'Customer portal (EU)', environment: 'prod' },
      headers: { 'if-match': created.etag },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; environment: string; etag: string }>()).toMatchObject({
      name: 'Customer portal (EU)',
      environment: 'prod',
      etag: '"v1"',
    });
    const events = await queryAs<{ action: string }>(
      tenantA,
      "SELECT action FROM audit_events WHERE target->>'id' = (SELECT id::text FROM assets WHERE id = $1) ORDER BY seq",
      [created.id],
    );
    expect(events.map((row) => row.action)).toEqual(['asset.created', 'asset.updated']);
  });

  it('lets exactly one of two concurrent writers with the same ETag win; the loser gets 409', async () => {
    const created = await createAs(ALICE);
    const [one, two] = await Promise.all([
      call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
        payload: { name: 'race-a' },
        headers: { 'if-match': created.etag },
      }),
      call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
        payload: { name: 'race-b' },
        headers: { 'if-match': created.etag },
      }),
    ]);
    const statuses = [one.statusCode, two.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('lets an asset owner change their own asset but not someone else’s, 403', async () => {
    const mine = await createAs(BOB, { ownerUserId: bob });
    expect(
      (
        await call(BOB, 'PATCH', `/v1/assets/${mine.id}`, {
          payload: { name: 'bob-own' },
          headers: { 'if-match': mine.etag },
        })
      ).statusCode,
    ).toBe(200);
    const theirs = await createAs(ALICE);
    expect(
      (
        await call(BOB, 'PATCH', `/v1/assets/${theirs.id}`, {
          payload: { name: 'bob-hijack' },
          headers: { 'if-match': theirs.etag },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('refuses an empty patch and an invalid identifier, 422; an owner outside the tenant, 422', async () => {
    const created = await createAs(ALICE);
    expect(
      (
        await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
          payload: {},
          headers: { 'if-match': created.etag },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
          payload: { identifiers: [{ kind: 'url', value: 'ftp://x.example' }] },
          headers: { 'if-match': created.etag },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
          payload: { ownerUserId: eve },
          headers: { 'if-match': created.etag },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('records an owner change as asset.owner_assigned', async () => {
    const created = await createAs(ALICE);
    const res = await call(ALICE, 'PATCH', `/v1/assets/${created.id}`, {
      payload: { ownerUserId: bob },
      headers: { 'if-match': created.etag },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ownerUserId: string }>().ownerUserId).toBe(bob);
    const events = await queryAs<{ action: string }>(
      tenantA,
      "SELECT action FROM audit_events WHERE target->>'id' = (SELECT id::text FROM assets WHERE id = $1) ORDER BY seq",
      [created.id],
    );
    expect(events.map((row) => row.action)).toContain('asset.owner_assigned');
  });
});

describe('DELETE /v1/assets/:id (soft delete)', () => {
  it('soft-deletes: 200 with the retired asset, hidden from GET and list, row retained, asset.deleted audited', async () => {
    const created = await createAs(ALICE, { name: 'to-retire' });
    const deleted = await call(ALICE, 'DELETE', `/v1/assets/${created.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<{ id: string; etag: string }>()).toMatchObject({
      id: created.id,
      etag: '"v1"',
    });
    expect((await call(ALICE, 'GET', `/v1/assets/${created.id}`)).statusCode).toBe(404);
    const listed = await call(ALICE, 'GET', '/v1/assets?limit=200');
    expect(listed.json<{ items: { id: string }[] }>().items.map((item) => item.id)).not.toContain(
      created.id,
    );
    const row = await queryAs<{ deleted: boolean }>(
      tenantA,
      'SELECT deleted_at IS NOT NULL AS deleted FROM assets WHERE id = $1',
      [created.id],
    );
    expect(row[0]?.deleted).toBe(true);
    const events = await queryAs<{ action: string }>(
      tenantA,
      "SELECT action FROM audit_events WHERE target->>'id' = (SELECT id::text FROM assets WHERE id = $1) ORDER BY seq",
      [created.id],
    );
    expect(events.map((r) => r.action)).toContain('asset.deleted');
  });

  it('refuses a stale If-Match with 409 and deletes nothing', async () => {
    const created = await createAs(ALICE);
    const res = await call(ALICE, 'DELETE', `/v1/assets/${created.id}`, {
      headers: { 'if-match': '"v7"' },
    });
    expect(res.statusCode).toBe(409);
    expect((await call(ALICE, 'GET', `/v1/assets/${created.id}`)).statusCode).toBe(200);
  });

  it('refuses a delete while an active or pending standing authorisation covers the asset (409 ASSET_IN_USE)', async () => {
    const created = await createAs(ALICE);
    const assetRow = await queryAs<{ id: string }>(tenantA, 'SELECT id FROM assets WHERE id = $1', [
      created.id,
    ]);
    const assetId = assetRow[0]?.id ?? '';
    await withTenant(db(), tenantA, (tx) =>
      tx.insert(standingAuthorisations).values({
        id: newId(),
        tenantId: tenantA,
        publicId: publicId('sa', newId()),
        assetIds: [assetId],
        scopeRules: {},
        maxIntrusiveness: 'passive',
        defaultBudgets: {},
        testWindows: [],
        validFrom: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        requesterId: alice,
        status: 'pending_approval',
      }),
    );
    const res = await call(ALICE, 'DELETE', `/v1/assets/${created.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('asset_in_use');
    expect((await call(ALICE, 'GET', `/v1/assets/${created.id}`)).statusCode).toBe(200);
  });

  it("answers 404 for another tenant's asset and leaves it intact; an auditor cannot delete, 403", async () => {
    const created = await createAs(ALICE);
    expect((await call(EVE, 'DELETE', `/v1/assets/${created.id}`)).statusCode).toBe(404);
    expect((await call(CAROL, 'DELETE', `/v1/assets/${created.id}`)).statusCode).toBe(403);
    expect((await call(ALICE, 'GET', `/v1/assets/${created.id}`)).statusCode).toBe(200);
  });
});

describe('the audit ledger', () => {
  it('keeps the tenant chain continuous: each event links to the previous hash', async () => {
    const rows = await queryAs<{ seq: string; prev_hash: Buffer | null; hash: Buffer }>(
      tenantA,
      'SELECT seq, prev_hash, hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq',
      [tenantA],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      expect(current?.prev_hash?.equals(previous?.hash ?? Buffer.alloc(0))).toBe(true);
    }
  });
});
