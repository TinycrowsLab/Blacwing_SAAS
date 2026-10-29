import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';
import { persistedHash, type PersistedManifests } from './persisted.js';

import type { AssessmentReadStore, MemberReadStore } from './store.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';

const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
const SESSION = `session:${TENANT}`;

const MEMBERS = 'query Members { tenantMembers { userId roles } }';
const MEMBERS_ID = persistedHash(MEMBERS);
const RETIRED = 'query Retired { tenantMembers { userId } }';
const RETIRED_ID = persistedHash(RETIRED);

/** No assessment rows: this suite covers the persisted-query gate, not the request reads. */
const assessments: AssessmentReadStore = {
  rolesOf: () => Promise.resolve([]),
  listRequests: () => Promise.resolve([]),
  findRequest: () => Promise.resolve(undefined),
};

const store: MemberReadStore = {
  listMembers: () => Promise.resolve([{ userId: 'usr_a1', roles: ['admin'] }]),
  findUsers: () => Promise.resolve(new Map()),
};

function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant] = header.split(':');
  if (kind !== 'session') return null;
  return { actor: { type: 'user', id: 'usr_test' }, sessionTenantId: tenant };
}

const MANIFESTS: PersistedManifests = {
  current: new Map([[MEMBERS_ID, MEMBERS]]),
  previous: [new Map([[RETIRED_ID, RETIRED]])],
};

let current: ApiApp | undefined;
let currentMetrics: ReturnType<typeof createHttpMetrics> | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(env: Record<string, string>, persisted: PersistedManifests): Promise<ApiApp> {
  const config = loadApiConfig({ WEB_ORIGIN: 'http://localhost:3000', ...env });
  const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const metrics = createHttpMetrics();
  currentMetrics = metrics;
  const app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers['x-test-principal']),
    imports: [GraphqlApiModule.forRoot({ config, logger, metrics, store, assessments, persisted })],
  });
  await app.app.getHttpAdapter().getInstance().ready();
  current = app;
  return app;
}

interface Body {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { extensions: { code: string } }[];
}

async function post(app: ApiApp, payload: object, principal = SESSION): Promise<Body> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json', 'x-test-principal': principal },
    payload,
  });
  return res.json<Body>();
}

const hashOf = (hash: string) => ({
  extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
});

describe('persisted-query gate on /graphql (API-GQL-PERSIST)', () => {
  it('production runs a known hash and answers with its data', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const body = await post(app, hashOf(MEMBERS_ID));
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ tenantMembers: [{ userId: 'usr_a1', roles: ['admin'] }] });
  });

  it('production refuses an unknown hash with persisted_query_not_found', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const body = await post(app, hashOf('e'.repeat(64)));
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions.code).toBe('persisted_query_not_found');
  });

  it('production refuses a raw query string with persisted_query_required', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const body = await post(app, { query: MEMBERS });
    expect(body.errors?.[0]?.extensions.code).toBe('persisted_query_required');
    expect(body.data ?? null).toBeNull();
  });

  it('production refuses everything when the manifest is empty (fail closed)', async () => {
    const app = await boot({ NODE_ENV: 'production' }, { current: new Map(), previous: [] });
    const body = await post(app, hashOf(MEMBERS_ID));
    expect(body.errors?.[0]?.extensions.code).toBe('persisted_manifest_unavailable');
  });

  it('a GET request is gated the same way: a raw query string is refused in production', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const res = await app.app.inject({
      method: 'GET',
      url: `/graphql?query=${encodeURIComponent(MEMBERS)}`,
      headers: { 'x-test-principal': SESSION },
    });
    expect(res.json<Body>().errors?.[0]?.extensions.code).toBe('persisted_query_required');
  });

  it('a GET request with a known hash in its extensions runs the reviewed text', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: MEMBERS_ID } });
    const res = await app.app.inject({
      method: 'GET',
      url: `/graphql?extensions=${encodeURIComponent(extensions)}`,
      headers: { 'x-test-principal': SESSION },
    });
    expect(res.json<Body>().errors).toBeUndefined();
    expect(res.json<Body>().data).toEqual({
      tenantMembers: [{ userId: 'usr_a1', roles: ['admin'] }],
    });
  });

  it('development still runs a raw query (DX preserved)', async () => {
    const app = await boot({ NODE_ENV: 'development' }, MANIFESTS);
    const body = await post(app, { query: MEMBERS });
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ tenantMembers: [{ userId: 'usr_a1', roles: ['admin'] }] });
  });

  it('API_GQL_PERSISTED_ONLY=true refuses raw queries even in development', async () => {
    const app = await boot({ NODE_ENV: 'development', API_GQL_PERSISTED_ONLY: 'true' }, MANIFESTS);
    const body = await post(app, { query: MEMBERS });
    expect(body.errors?.[0]?.extensions.code).toBe('persisted_query_required');
  });

  it('API_GQL_PERSISTED_ONLY=false lets production run raw queries', async () => {
    const app = await boot({ NODE_ENV: 'production', API_GQL_PERSISTED_ONLY: 'false' }, MANIFESTS);
    const body = await post(app, { query: MEMBERS });
    expect(body.errors).toBeUndefined();
  });

  it('a previous-generation id still runs within the grace window', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const body = await post(app, hashOf(RETIRED_ID));
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ tenantMembers: [{ userId: 'usr_a1' }] });
  });

  it('a known hash still goes through the tenant guard (no bypass of authn)', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    const res = await app.app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: hashOf(MEMBERS_ID),
    });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json<Body>().data ?? null).toBeNull();
  });

  it('counts hits, misses and rejections on the registry', async () => {
    const app = await boot({ NODE_ENV: 'production' }, MANIFESTS);
    await post(app, hashOf(MEMBERS_ID));
    await post(app, hashOf('d'.repeat(64)));
    await post(app, { query: MEMBERS });
    const exposition = await currentMetrics?.registry.metrics();
    expect(exposition).toMatch(/graphql_persisted_hits_total 1/);
    expect(exposition).toMatch(/graphql_persisted_misses_total 1/);
    expect(exposition).toMatch(
      /graphql_persisted_rejected_total\{reason="persisted_query_required"\} 1/,
    );
  });
});
