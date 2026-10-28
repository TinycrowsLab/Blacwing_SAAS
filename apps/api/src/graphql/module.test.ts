import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, type Logger } from '@blackwing/logger';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig, type ApiConfig } from '../config.js';
import { GraphqlApiModule } from './module.js';

import type { MemberReadStore, MemberRow, UserRow } from './store.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';

/** Test IAM: the principal comes from a header the test controls, never from the query. */
function principalOf(header: unknown): TenantPrincipal | null {
  if (typeof header !== 'string') return null;
  const [kind, tenant] = header.split(':');
  const actor = { type: 'user', id: 'usr_test' } as const;
  if (kind === 'session') return { actor, sessionTenantId: tenant };
  return null;
}

interface Seed {
  readonly members: readonly MemberRow[];
  readonly users: readonly UserRow[];
}

const SEED: Readonly<Record<string, Seed>> = {
  [TENANT_A]: {
    members: [
      { userId: 'usr_a1', roles: ['admin'] },
      { userId: 'usr_a2', roles: ['viewer'] },
      { userId: 'usr_a3', roles: ['viewer'] },
    ],
    users: [
      { id: 'usr_a1', name: 'Ada', email: 'ada@a.test' },
      { id: 'usr_a2', name: 'Ben', email: 'ben@a.test' },
      { id: 'usr_a3', name: null, email: 'cy@a.test' },
    ],
  },
  [TENANT_B]: {
    members: [
      { userId: 'usr_b1', roles: ['viewer'] },
      { userId: 'usr_broken', roles: ['viewer'] },
    ],
    users: [{ id: 'usr_b1', name: 'Bea', email: 'bea@b.test' }],
  },
};

/**
 * A store that behaves like the tenant-scoped Postgres one: every read is confined to the tenant it is
 * given, and a user is visible only through its membership of that tenant.
 */
function fakeStore(seed: Readonly<Record<string, Seed>> = SEED) {
  const findCalls: { tenantId: string; ids: string[] }[] = [];
  const store: MemberReadStore = {
    listMembers: (tenantId, limit) =>
      Promise.resolve((seed[tenantId]?.members ?? []).slice(0, limit)),
    findUsers(tenantId, userIds) {
      findCalls.push({ tenantId, ids: [...userIds] });
      if (userIds.includes('usr_broken'))
        return Promise.reject(new Error('connection reset by 10.0.0.5:5432'));
      const scoped = seed[tenantId];
      const members = new Set(scoped?.members.map((member) => member.userId));
      const found = new Map<string, UserRow>();
      for (const user of scoped?.users ?? []) {
        if (userIds.includes(user.id) && members.has(user.id)) found.set(user.id, user);
      }
      return Promise.resolve(found);
    },
  };
  return { store, findCalls };
}

const BASE_ENV = { WEB_ORIGIN: 'http://localhost:3000' };

let current: ApiApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(
  env: Record<string, string> = {},
  store: MemberReadStore = fakeStore().store,
  logger: Logger = createLogger('api', { level: 'silent', nodeEnv: 'test' }),
): Promise<{
  app: ApiApp;
  metrics: ReturnType<typeof createHttpMetrics>;
  config: Readonly<ApiConfig>;
}> {
  const config = loadApiConfig({ NODE_ENV: 'test', ...BASE_ENV, ...env });
  const metrics = createHttpMetrics();
  const app = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers['x-test-principal']),
    imports: [GraphqlApiModule.forRoot({ config, logger, metrics, store })],
  });
  await app.app.getHttpAdapter().getInstance().ready();
  current = app;
  return { app, metrics, config };
}

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { message: string; path?: unknown[]; extensions: Record<string, unknown> }[];
}

async function gql(
  app: ApiApp,
  query: string,
  options: { principal?: string; variables?: Record<string, unknown> } = {},
): Promise<GqlBody> {
  const res = await app.app.inject({
    method: 'POST',
    url: '/graphql',
    headers: {
      'content-type': 'application/json',
      ...(options.principal === undefined ? {} : { 'x-test-principal': options.principal }),
    },
    payload: { query, variables: options.variables ?? {} },
  });
  return res.json<GqlBody>();
}

const SESSION_A = `session:${TENANT_A}`;
const SESSION_B = `session:${TENANT_B}`;

const MEMBERS_WITH_USERS = `{ tenantMembers { userId roles user { name email } } }`;

describe('GraphQL read layer (API-009)', () => {
  it('serves a sample query scoped to the caller tenant', async () => {
    const { app } = await boot();
    const body = await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_A });
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      tenantMembers: [
        { userId: 'usr_a1', roles: ['admin'], user: { name: 'Ada', email: 'ada@a.test' } },
        { userId: 'usr_a2', roles: ['viewer'], user: { name: 'Ben', email: 'ben@a.test' } },
        { userId: 'usr_a3', roles: ['viewer'], user: { name: null, email: 'cy@a.test' } },
      ],
    });
  });

  it('never returns another tenant rows, even for the same query', async () => {
    const { app } = await boot();
    const body = await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_B });
    const ids = (body.data?.tenantMembers as { userId: string }[]).map((m) => m.userId);
    expect(ids).toEqual(['usr_b1', 'usr_broken']);
    expect(JSON.stringify(body)).not.toMatch(/usr_a|Ada|ada@a\.test/);
  });

  it('batches the nested user lookups of one response into a single store call', async () => {
    const { store, findCalls } = fakeStore();
    const { app } = await boot({}, store);
    await gql(app, '{ tenantMembers { user { id } } }', { principal: SESSION_A });
    expect(findCalls).toEqual([{ tenantId: TENANT_A, ids: ['usr_a1', 'usr_a2', 'usr_a3'] }]);
  });

  it('answers unauthenticated access with the unauthenticated code and no data', async () => {
    const { app } = await boot();
    const body = await gql(app, MEMBERS_WITH_USERS);
    expect(body.data).toBeNull();
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects a query over the depth limit with query_too_complex', async () => {
    const { app, metrics } = await boot({ API_GQL_MAX_DEPTH: '2' });
    const body = await gql(app, '{ tenantMembers { user { name } } }', { principal: SESSION_A });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
    expect(body.errors?.[0]?.message).toMatch(/depth 3 exceeds the limit of 2/);
    expect(body.data).toBeNull();
    expect(await metrics.registry.metrics()).toMatch(/graphql_rejected_total\{reason="depth"\} 1/);
  });

  it('rejects a query over the complexity limit with query_too_complex', async () => {
    const { app } = await boot({ API_GQL_MAX_COMPLEXITY: '10' });
    const body = await gql(app, '{ tenantMembers(first: 20) { userId } }', {
      principal: SESSION_A,
    });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
  });

  it('prices a variable page size from its value', async () => {
    const { app } = await boot({ API_GQL_MAX_COMPLEXITY: '10' });
    const query = 'query Q($n: Int) { tenantMembers(first: $n) { userId } }';
    const small = await gql(app, query, { principal: SESSION_A, variables: { n: 2 } });
    expect(small.errors).toBeUndefined();
    expect(small.data).toEqual({
      tenantMembers: [{ userId: 'usr_a1' }, { userId: 'usr_a2' }],
    });
    const large = await gql(app, query, { principal: SESSION_A, variables: { n: 200 } });
    expect(large.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
  });

  it('rejects an alias flood with query_too_complex', async () => {
    const { app } = await boot({ API_GQL_MAX_ALIASES: '2' });
    const aliased = ['a', 'b', 'c'].map((name) => `${name}: tenantMembers(first: 1) { userId }`);
    const body = await gql(app, `{ ${aliased.join(' ')} }`, { principal: SESSION_A });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'query_too_complex' });
  });

  it('keeps data for the fields that resolved when one resolver fails (partial failure)', async () => {
    const { app } = await boot();
    const body = await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_B });
    expect(body.data).toEqual({
      tenantMembers: [
        { userId: 'usr_b1', roles: ['viewer'], user: null },
        { userId: 'usr_broken', roles: ['viewer'], user: null },
      ],
    });
    expect(body.errors).toHaveLength(2);
    // Mercurius types every path item as a string in its response schema, so the list index arrives as '0'.
    expect(body.errors?.[0]?.path).toEqual(['tenantMembers', expect.anything(), 'user']);
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'internal_error' });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/10\.0\.0\.5|connection reset|at .*\.ts/);
  });

  it('answers a non-positive or oversized page with validation_failed', async () => {
    const { app } = await boot();
    for (const first of [0, 201]) {
      const body = await gql(app, `{ tenantMembers(first: ${first}) { userId } }`, {
        principal: SESSION_A,
      });
      expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
    }
  });

  it('defines no mutation: a write is refused by validation', async () => {
    const { app } = await boot();
    const body = await gql(app, 'mutation { tenantMembers { userId } }', { principal: SESSION_A });
    expect(body.errors?.[0]?.extensions).toMatchObject({ code: 'validation_failed' });
  });

  it('serves introspection and GraphiQL outside production', async () => {
    const { app } = await boot();
    const body = await gql(app, '{ __schema { queryType { name } } }', { principal: SESSION_A });
    expect(body.data).toEqual({ __schema: { queryType: { name: 'Query' } } });
    const ide = await app.app.inject({ method: 'GET', url: '/graphiql' });
    expect(ide.statusCode).toBe(200);
  });

  it('turns introspection and GraphiQL off in production', async () => {
    // Raw documents are refused by the persisted-query gate first; this opts it out to exercise the schema rule.
    const { app } = await boot({ NODE_ENV: 'production', API_GQL_PERSISTED_ONLY: 'false' });
    const body = await gql(app, '{ __schema { queryType { name } } }', { principal: SESSION_A });
    expect(body.data).toBeNull();
    expect(body.errors?.[0]).toMatchObject({ extensions: { code: 'validation_failed' } });
    const typeOnly = await gql(app, '{ __type(name: "User") { name } }', { principal: SESSION_A });
    expect(typeOnly.errors?.[0]).toMatchObject({ extensions: { code: 'validation_failed' } });
    const ide = await app.app.inject({ method: 'GET', url: '/graphiql' });
    expect(ide.statusCode).toBe(404);
  });

  it('still serves queries in production when raw documents are opted in', async () => {
    // The persisted path is covered in persisted.gate.test.ts; this checks the resolver path under production.
    const { app } = await boot({ NODE_ENV: 'production', API_GQL_PERSISTED_ONLY: 'false' });
    const body = await gql(app, '{ tenantMembers(first: 1) { userId } }', { principal: SESSION_A });
    expect(body).toEqual({ data: { tenantMembers: [{ userId: 'usr_a1' }] } });
  });

  it('opens a span per resolver, named by its parent type and field', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
    const { app } = await boot();
    await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_A });
    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toEqual(
      expect.arrayContaining(['graphql Query.tenantMembers', 'graphql TenantMember.user']),
    );
    await provider.shutdown();
  });

  it('logs a rejected operation by name and reason, never its query text', async () => {
    const lines: string[] = [];
    const logger = createLogger('api', {
      level: 'info',
      nodeEnv: 'test',
      destination: { write: (line: string) => void lines.push(line) },
    });
    const { app } = await boot({ API_GQL_MAX_DEPTH: '2' }, fakeStore().store, logger);
    await gql(app, 'query Deep { tenantMembers { user { name } } }', { principal: SESSION_A });
    const rejected = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === 'graphql.query_rejected');
    expect(rejected).toMatchObject({ operation: 'Deep', reason: 'depth', depth: 3 });
    expect(lines.join('\n')).not.toMatch(/user \{ name \}/);
  });

  it('exports the GraphQL metrics with bounded labels', async () => {
    const { app, metrics } = await boot();
    await gql(app, 'query Dashboard { tenantMembers(first: 1) { userId } }', {
      principal: SESSION_A,
    });
    await gql(app, '{ tenantMembers(first: 1) { userId } }', { principal: SESSION_A });
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/graphql_requests_total\{operation="Dashboard"\} 1/);
    expect(text).toMatch(/graphql_requests_total\{operation="anonymous"\} 1/);
    expect(text).toMatch(/graphql_complexity_count 2/);
  });

  it('charges the rate limit once per operation, not once per resolver', async () => {
    // One token: the first operation (four resolvers, one call each per member) must spend exactly one.
    const { app } = await boot({ RATE_LIMIT_BURST: '1', RATE_LIMIT_DEFAULT_RPS: '1' });
    const first = await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_A });
    expect(first.errors).toBeUndefined();
    const second = await gql(app, MEMBERS_WITH_USERS, { principal: SESSION_A });
    expect(second.errors?.[0]?.extensions).toMatchObject({ code: 'rate_limited' });
  });
});
