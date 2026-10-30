import { Writable } from 'node:stream';

import { Controller, Get, Module, Post } from '@nestjs/common';
import { GraphQLModule, Query, Resolver } from '@nestjs/graphql';
import { MercuriusDriver, type MercuriusDriverConfig } from '@nestjs/mercurius';
import { afterEach, describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS, ROLES, type Problem } from '@blackwing/contracts';
import { createLogger } from '@blackwing/logger';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import {
  AuthenticatedOnly,
  RequireAnyPermission,
  RequirePermission,
} from './require-permission.decorator.js';
import { formatGraphqlErrors } from '../graphql/errors.js';
import { PublicRoute } from '../tenant/public-route.js';

import type { AuthorizedPrincipal } from '../tenant/guard.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';

/**
 * Test IAM. The header is `actor:roles:scopes`, for example `user:developer:` or `service:developer:run:create`
 * (roles and scopes are comma lists, empty when absent). The tenant is always TENANT_A.
 */
function principalOf(headers: Record<string, unknown>): AuthorizedPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [kind = '', roles = '', ...rest] = who.split(':');
  const scopes = rest.join(':');
  const list = (value: string): string[] => value.split(',').filter((item) => item !== '');
  if (kind === 'user') {
    const principal: TenantPrincipal = {
      actor: { type: 'user', id: 'usr_1' },
      sessionTenantId: TENANT_A,
    };
    return { ...principal, roles: list(roles), scopes: list(scopes) };
  }
  if (kind === 'service') {
    const principal: TenantPrincipal = {
      actor: { type: 'service', id: 'svc_1' },
      tokenTenantId: TENANT_A,
    };
    return { ...principal, roles: list(roles), scopes: list(scopes) };
  }
  return null;
}

let touched = 0;

@Controller('rbac-probe')
class RbacProbeController {
  @RequirePermission('run:create')
  @Post('run')
  run(): { ok: true } {
    touched += 1;
    return { ok: true };
  }

  @RequireAnyPermission('sa:approve', 'asset:read')
  @Get('any')
  any(): { ok: true } {
    touched += 1;
    return { ok: true };
  }

  @RequirePermission('run:create', 'sa:approve')
  @Get('all')
  all(): { ok: true } {
    touched += 1;
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('me')
  me(): { ok: true } {
    touched += 1;
    return { ok: true };
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    touched += 1;
    return { ok: true };
  }

  @PublicRoute()
  @Get('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [RbacProbeController] })
class RbacProbeModule {}

@Resolver()
class RbacProbeResolver {
  @RequirePermission('run:create')
  @Query(() => String, { name: 'rbacRun', nullable: true })
  run(): string {
    touched += 1;
    return 'ran';
  }

  @Query(() => String, { name: 'rbacUndeclared', nullable: true })
  undeclared(): string {
    touched += 1;
    return 'open';
  }

  @AuthenticatedOnly()
  @Query(() => String, { name: 'rbacMe', nullable: true })
  me(): string {
    touched += 1;
    return 'me';
  }
}

@Module({ providers: [RbacProbeResolver] })
class RbacProbeResolverModule {}

let current: ApiApp | undefined;
let logLines: string[] = [];

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

async function boot(): Promise<ApiApp> {
  touched = 0;
  logLines = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  const config = loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' });
  const logger = createLogger('api', { level: 'warn', nodeEnv: 'test', destination: stream });
  const metrics = createHttpMetrics();
  // An in-memory schema: the probe resolvers must not be written to the committed apps/api/schema.gql.
  const probeGraphql = GraphQLModule.forRoot<MercuriusDriverConfig>({
    driver: MercuriusDriver,
    autoSchemaFile: true,
    graphiql: false,
    errorFormatter: (execution) => formatGraphqlErrors(execution),
  });
  const created = await createApiApp({
    config,
    logger,
    metrics,
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [RbacProbeModule, RbacProbeResolverModule, probeGraphql],
  });
  await created.app.getHttpAdapter().getInstance().ready();
  current = created;
  return created;
}

const rest = (
  app: NestFastifyApplication,
  method: 'GET' | 'POST',
  url: string,
  principal?: string,
) =>
  app.inject({
    method,
    url,
    headers: principal === undefined ? {} : { 'x-test-principal': principal },
  });

interface GqlBody {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: { extensions: { code?: string } }[];
}

const gql = async (
  app: NestFastifyApplication,
  query: string,
  principal?: string,
): Promise<GqlBody> => {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: {
      'content-type': 'application/json',
      ...(principal === undefined ? {} : { 'x-test-principal': principal }),
    },
    payload: { query },
  });
  return res.json<GqlBody>();
};

/** The value of `bw_rbac_denials_total{permission}` on the app's registry. */
const denialCount = async (permission: string): Promise<number> => {
  const text = (await current?.metrics.registry.metrics()) ?? '';
  const match = new RegExp(`bw_rbac_denials_total\\{permission="${permission}"\\} (\\d+)`).exec(
    text,
  );
  return match === null ? 0 : Number(match[1]);
};

const DEVELOPER = 'user:developer:';
const AUDITOR = 'user:auditor:';
/** A role without sa:approve, and one with it, both taken from the catalogue. */
const APPROVER = `user:${ROLES.find((role) => ROLE_PERMISSIONS[role].includes('sa:approve')) ?? 'none'}:`;

describe('@RequirePermission guard over REST (RBAC-003)', () => {
  it('lets a caller holding the permission through, and refuses one without it', async () => {
    const { app } = await boot();
    expect((await rest(app, 'POST', '/v1/rbac-probe/run', DEVELOPER)).statusCode).toBe(201);
    const denied = await rest(app, 'POST', '/v1/rbac-probe/run', AUDITOR);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['content-type']).toContain('application/problem+json');
    expect(denied.json<Problem>().code).toBe('permission_denied');
    expect(touched).toBe(1);
  });

  it('refuses an empty role list and a list of unknown roles (deny by default)', async () => {
    const { app } = await boot();
    expect((await rest(app, 'POST', '/v1/rbac-probe/run', 'user::')).statusCode).toBe(403);
    expect(
      (await rest(app, 'POST', '/v1/rbac-probe/run', 'user:superuser,Org_Admin:')).statusCode,
    ).toBe(403);
    expect(touched).toBe(0);
  });

  it('answers 401 with no principal before any permission is evaluated', async () => {
    const { app } = await boot();
    const res = await rest(app, 'POST', '/v1/rbac-probe/run');
    expect(res.statusCode).toBe(401);
    expect(touched).toBe(0);
    expect(await denialCount('run:create')).toBe(0);
  });

  it('requires every listed permission for @RequirePermission with several names', async () => {
    const { app } = await boot();
    expect((await rest(app, 'GET', '/v1/rbac-probe/all', DEVELOPER)).statusCode).toBe(403);
    expect((await rest(app, 'GET', '/v1/rbac-probe/all', 'user:developer,admin:')).statusCode).toBe(
      403,
    );
  });

  it('passes @RequireAnyPermission with one of the listed permissions, and refuses with none', async () => {
    const { app } = await boot();
    expect((await rest(app, 'GET', '/v1/rbac-probe/any', APPROVER)).statusCode).toBe(200);
    expect((await rest(app, 'GET', '/v1/rbac-probe/any', 'user:superuser:')).statusCode).toBe(403);
  });

  it('intersects a token scope with its owner roles: a narrower token is limited to the scope', async () => {
    const { app } = await boot();
    expect(
      (await rest(app, 'POST', '/v1/rbac-probe/run', 'service:developer:run:create')).statusCode,
    ).toBe(201);
    // The owner holds run:create, but the token only carries asset:read.
    expect(
      (await rest(app, 'POST', '/v1/rbac-probe/run', 'service:developer:asset:read')).statusCode,
    ).toBe(403);
  });

  it('never lets a token scope exceed its owner roles (no privilege amplification)', async () => {
    const { app } = await boot();
    // The scope names sa:approve, but the owner roles (auditor) do not grant it.
    expect(
      (await rest(app, 'GET', '/v1/rbac-probe/any', 'service:auditor:sa:approve')).statusCode,
    ).toBe(403);
    expect((await rest(app, 'POST', '/v1/rbac-probe/run', 'service::run:create')).statusCode).toBe(
      403,
    );
  });

  it('counts each denial by permission and logs rbac.denied with the route template only', async () => {
    const { app } = await boot();
    await rest(app, 'POST', '/v1/rbac-probe/run', AUDITOR);
    await rest(app, 'POST', '/v1/rbac-probe/run?secret=1', AUDITOR);
    expect(await denialCount('run:create')).toBe(2);
    const records = logLines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const denied = records.filter((record) => record.msg === 'rbac.denied');
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({
      permission: 'run:create',
      route: '/v1/rbac-probe/run',
      principal: 'usr_1',
      level: 'warn',
    });
    expect(logLines.join('')).not.toContain('secret=1');
  });
});

describe('deny by default for undeclared routes (RBAC-003)', () => {
  it('lets a session through an undeclared route, and denies a token', async () => {
    const { app } = await boot();
    expect((await rest(app, 'GET', '/v1/rbac-probe/undeclared', DEVELOPER)).statusCode).toBe(200);
    const token = await rest(app, 'GET', '/v1/rbac-probe/undeclared', 'service:admin:');
    expect(token.statusCode).toBe(403);
    expect(token.json<Problem>().code).toBe('permission_denied');
    expect(touched).toBe(1);
  });

  it('lets any authenticated caller through @AuthenticatedOnly(), and still needs a principal', async () => {
    const { app } = await boot();
    expect((await rest(app, 'GET', '/v1/rbac-probe/me', 'service::')).statusCode).toBe(200);
    expect((await rest(app, 'GET', '/v1/rbac-probe/me', AUDITOR)).statusCode).toBe(200);
    expect((await rest(app, 'GET', '/v1/rbac-probe/me')).statusCode).toBe(401);
  });

  it('leaves @PublicRoute() open without a principal', async () => {
    const { app } = await boot();
    expect((await rest(app, 'GET', '/v1/rbac-probe/open')).statusCode).toBe(200);
  });
});

describe('the same decorator over GraphQL (RBAC-003)', () => {
  it('protects a query resolver: allowed for the permission, denied with permission_denied otherwise', async () => {
    const { app } = await boot();
    const allowed = await gql(app, '{ rbacRun }', DEVELOPER);
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ rbacRun: 'ran' });
    const denied = await gql(app, '{ rbacRun }', AUDITOR);
    expect(denied.data?.rbacRun ?? null).toBeNull();
    expect(denied.errors?.[0]?.extensions.code).toBe('permission_denied');
  });

  it('runs the guard per protected field, so each aliased field is checked', async () => {
    const { app } = await boot();
    const body = await gql(app, '{ a: rbacRun b: rbacRun }', AUDITOR);
    expect(body.errors).toHaveLength(2);
    expect(await denialCount('run:create')).toBe(2);
  });

  it('denies a token on an undeclared resolver and allows an authenticated caller on @AuthenticatedOnly()', async () => {
    const { app } = await boot();
    const undeclared = await gql(app, '{ rbacUndeclared }', 'service:admin:');
    expect(undeclared.errors?.[0]?.extensions.code).toBe('permission_denied');
    expect((await gql(app, '{ rbacUndeclared }', DEVELOPER)).data).toEqual({
      rbacUndeclared: 'open',
    });
    expect((await gql(app, '{ rbacMe }', 'service::')).data).toEqual({ rbacMe: 'me' });
  });

  it('answers unauthenticated GraphQL access with an error and no data', async () => {
    const { app } = await boot();
    const body = await gql(app, '{ rbacRun }');
    expect(body.data?.rbacRun ?? null).toBeNull();
    expect(body.errors?.[0]?.extensions.code).toBe('unauthenticated');
    expect(touched).toBe(0);
  });
});
