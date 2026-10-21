import { setTimeout as sleep } from 'node:timers/promises';

import { Controller, Get, Module, Post } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentTenantId,
  getTenantContextOrThrow,
  type TenantPrincipal,
} from '@blackwing/db/tenant-context';
import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { PublicRoute } from './public-route.js';

import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { Problem } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';

/** Test IAM: the validated principal is looked up from a header the test controls, never from the body. */
function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const who = headers['x-test-principal'];
  if (typeof who !== 'string') return null;
  const [kind, tenant] = who.split(':');
  const actor = { type: 'user', id: 'usr_1' } as const;
  if (kind === 'session') return { actor, sessionTenantId: tenant };
  if (kind === 'bearer') return { actor: { type: 'service', id: 'svc_1' }, tokenTenantId: tenant };
  if (kind === 'both') return { actor, sessionTenantId: TENANT_A, tokenTenantId: TENANT_B };
  return { actor };
}

let touched = 0;

@Controller('probe')
class ProbeController {
  @Get('tenant')
  tenant(): { tenantId: string; actorType: string } {
    touched += 1;
    const { tenantId, actor } = getTenantContextOrThrow();
    return { tenantId, actorType: actor.type };
  }

  @Get('slow')
  async slow(): Promise<{ before: string | undefined; after: string | undefined }> {
    const before = currentTenantId();
    await sleep(before === TENANT_A ? 40 : 5);
    await Promise.resolve();
    return { before, after: currentTenantId() };
  }

  @Post('echo')
  echo(): { tenantId: string } {
    return { tenantId: getTenantContextOrThrow().tenantId };
  }

  @PublicRoute()
  @Get('open')
  open(): { ok: true; context: string | undefined } {
    return { ok: true, context: currentTenantId() };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let app: NestFastifyApplication;
let metrics: HttpMetrics;

beforeEach(async () => {
  touched = 0;
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    tenantPrincipalSource: (request: FastifyRequest) => principalOf(request.headers),
    imports: [ProbeModule],
  });
  app = created.app;
  metrics = created.metrics;
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const get = (url: string, principal?: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: principal === undefined ? {} : { 'x-test-principal': principal },
  });

describe('tenant context guard', () => {
  it('fills the ambient context from a session principal', async () => {
    const res = await get('/v1/probe/tenant', `session:${TENANT_A}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: TENANT_A, actorType: 'user' });
  });

  it('fills the ambient context from a bearer principal', async () => {
    const res = await get('/v1/probe/tenant', `bearer:${TENANT_B}`);
    expect(res.json()).toEqual({ tenantId: TENANT_B, actorType: 'service' });
  });

  it('answers 401 with no principal and never runs the handler', async () => {
    const res = await get('/v1/probe/tenant');
    expect(res.statusCode).toBe(401);
    expect(touched).toBe(0);
  });

  it.each([
    ['no tenant on the principal', 'none:'],
    ['a tenant that is not a uuid', 'session:not-a-uuid'],
    ['two disagreeing tenants', 'both:'],
  ])('answers 403 TENANT_CONTEXT_MISSING for %s without touching data', async (_n, principal) => {
    const res = await get('/v1/probe/tenant', principal);
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<Problem>().code).toBe('tenant_context_missing');
    expect(touched).toBe(0);
    expect(
      await metrics.registry.getSingleMetricAsString('bw_tenant_context_missing_total'),
    ).toMatch(/bw_tenant_context_missing_total [1-9]/);
  });

  it('ignores a tenant id forged in the body, query or headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/probe/echo?tenantId=${TENANT_B}`,
      headers: {
        'x-test-principal': `session:${TENANT_A}`,
        'x-tenant-id': TENANT_B,
        'content-type': 'application/json',
      },
      payload: { tenantId: TENANT_B, tenant_id: TENANT_B },
    });
    expect(res.json()).toEqual({ tenantId: TENANT_A });
  });

  it('leaves @PublicRoute() routes open and context-free', async () => {
    const res = await get('/v1/probe/open');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, context: undefined });
  });

  it('keeps probes and the banner open', async () => {
    expect((await get('/health/live')).statusCode).toBe(200);
    expect((await get('/v1')).statusCode).toBe(200);
  });

  it('never bleeds context between interleaved requests of different tenants', async () => {
    const calls = Array.from({ length: 24 }, (_unused, index) => {
      const tenant = index % 2 === 0 ? TENANT_A : TENANT_B;
      return { tenant, result: get('/v1/probe/slow', `session:${tenant}`) };
    });
    for (const { tenant, result } of calls) {
      const res = await result;
      expect(res.json()).toEqual({ before: tenant, after: tenant });
    }
  });
});
