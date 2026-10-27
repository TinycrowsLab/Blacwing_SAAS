// Rate limiting over HTTP (CONTEXT_PACK §9, API rate-limit): the guard behind the real tenant guard, with an
// in-process limiter on a fixed clock so every number below is exact.

import { randomUUID } from 'node:crypto';

import { Controller, HttpCode, Module, Post } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { InProcessRateLimiter, type RateLimiter } from './limiter.js';
import { RateLimit, type RateLimitConfig } from './policy.js';
import { ThingLog, thingsModule } from '../idempotency/fixtures.test-helpers.js';
import { InMemoryIdempotencyStore } from '../idempotency/memory.js';
import { PublicRoute } from '../tenant/public-route.js';

import type { TenantPrincipalSource } from '../tenant/guard.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const TENANT_A = '0190f2a0-0000-7000-8000-00000000000a';
const TENANT_B = '0190f2a0-0000-7000-8000-00000000000b';
const T0 = 1_700_000_000_000;

/** Test stand-in for IAM: the principal is the `x-test-token` header, bound to the `x-test-tenant` header. */
const principalSource: TenantPrincipalSource = (request) => {
  const token = request.headers['x-test-token'];
  const tenant = request.headers['x-test-tenant'];
  if (typeof token !== 'string' || typeof tenant !== 'string') return null;
  return { actor: { type: 'service', id: token }, tokenTenantId: tenant };
};

/** A public, unauthenticated route with its own limit, as a login route would be. */
@PublicRoute()
@Controller('signin')
class SigninController {
  @Post()
  @HttpCode(200)
  @RateLimit({ routeClass: 'auth', rps: 1, burst: 1 })
  signin(): { readonly ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [SigninController] })
class SigninModule {}

let app: NestFastifyApplication;
let log: ThingLog;
let now: number;
let registry: { getSingleMetricAsString(name: string): Promise<string> };

interface BootOptions {
  readonly limiter?: RateLimiter;
  readonly config?: RateLimitConfig;
}

async function boot(options: BootOptions = {}): Promise<void> {
  log = new ThingLog();
  now = T0;
  const created = await createApiApp({
    config: loadApiConfig({
      NODE_ENV: 'test',
      WEB_ORIGIN: 'http://localhost:3000',
      RATE_LIMIT_DEFAULT_RPS: '1',
      RATE_LIMIT_BURST: '2',
    }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    tenantPrincipalSource: principalSource,
    idempotencyStore: new InMemoryIdempotencyStore(() => now),
    rateLimiter: options.limiter ?? new InProcessRateLimiter({ now: () => now }),
    ...(options.config === undefined ? {} : { rateLimitConfig: options.config }),
    imports: [thingsModule(log), SigninModule],
  });
  app = created.app;
  registry = created.metrics.registry;
  await app.getHttpAdapter().getInstance().ready();
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app.close();
});

function createThing(token: string, tenant: string, remoteAddress = '198.51.100.10') {
  return app.inject({
    method: 'POST',
    url: '/v1/things',
    remoteAddress,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${randomUUID()}`,
      'x-test-token': token,
      'x-test-tenant': tenant,
    },
    payload: { name: 'one' },
  });
}

async function blockedCount(scope: string): Promise<number> {
  const text = await registry.getSingleMetricAsString('rate_limit_blocked_total');
  const match = new RegExp(`scope="${scope}"\\} (\\d+)`).exec(text);
  return match === null ? 0 : Number(match[1]);
}

describe('rate limiting over HTTP', () => {
  it('serves a token until its burst is spent, then answers 429 with Retry-After and RateLimit headers', async () => {
    const first = await createThing('bw_pat_one', TENANT_A);
    expect(first.statusCode).toBe(201);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');

    expect((await createThing('bw_pat_one', TENANT_A)).statusCode).toBe(201);

    const denied = await createThing('bw_pat_one', TENANT_A);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers['retry-after']).toBe('1');
    expect(denied.headers['ratelimit-remaining']).toBe('0');
    expect(denied.headers['content-type']).toContain('application/problem+json');
    expect(denied.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    // The refused request never reached the handler.
    expect(log.created).toBe(2);
    expect(await blockedCount('principal')).toBe(1);
  });

  it('limits two tokens of one tenant independently, but both are bounded by the tenant ceiling', async () => {
    await app.close();
    await boot({
      config: {
        limitsFor: ({ scope }) => (scope === 'tenant' ? { rps: 1, burst: 3 } : undefined),
      },
    });
    expect((await createThing('bw_pat_a', TENANT_A)).statusCode).toBe(201);
    expect((await createThing('bw_pat_a', TENANT_A)).statusCode).toBe(201);
    // Token A has spent its own burst of 2: refused on its own bucket.
    expect((await createThing('bw_pat_a', TENANT_A)).statusCode).toBe(429);
    // Token B has its own full bucket, so it is served, but the tenant ceiling of 3 is now down to one left.
    expect((await createThing('bw_pat_b', TENANT_A)).statusCode).toBe(201);
    const bounded = await createThing('bw_pat_b', TENANT_A);
    expect(bounded.statusCode).toBe(429);
    expect(await blockedCount('tenant')).toBe(1);
  });

  it('isolates tenants: exhausting one tenant does not throttle another, even with the same token id', async () => {
    await createThing('bw_pat_same', TENANT_A);
    await createThing('bw_pat_same', TENANT_A);
    expect((await createThing('bw_pat_same', TENANT_A)).statusCode).toBe(429);
    expect((await createThing('bw_pat_same', TENANT_B)).statusCode).toBe(201);
  });

  it('limits unauthenticated routes per client IP, and keeps IPs independent', async () => {
    const from = (address: string) =>
      app.inject({ method: 'GET', url: '/v1', remoteAddress: address });
    expect((await from('198.51.100.1')).statusCode).toBe(200);
    expect((await from('198.51.100.1')).statusCode).toBe(200);
    const refused = await from('198.51.100.1');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect((await from('198.51.100.2')).statusCode).toBe(200);
    expect(await blockedCount('ip')).toBe(1);
  });

  it('never limits health probes', async () => {
    for (let i = 0; i < 6; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/health/live',
        remoteAddress: '198.51.100.9',
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('applies a route class and override from @RateLimit to that route', async () => {
    const signin = () =>
      app.inject({ method: 'POST', url: '/v1/signin', remoteAddress: '198.51.100.20' });
    expect((await signin()).statusCode).toBe(200);
    expect((await signin()).statusCode).toBe(429);
    const text = await registry.getSingleMetricAsString('rate_limit_blocked_total');
    expect(text).toContain('routeClass="auth",scope="ip"} 1');
  });

  it('answers 401 before any bucket is charged, so unauthenticated calls cannot drain a limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/things', payload: { name: 'x' } }))
          .statusCode,
      ).toBe(401);
    }
    expect((await createThing('bw_pat_late', TENANT_A)).statusCode).toBe(201);
    expect((await createThing('bw_pat_late', TENANT_A)).statusCode).toBe(201);
  });

  it('keeps serving through the in-process fallback when the shared limiter fails, and counts the degradation', async () => {
    await app.close();
    const broken: RateLimiter = {
      consume: () => Promise.reject(new Error('valkey unreachable')),
    };
    await boot({ limiter: broken });
    expect((await createThing('bw_pat_fb', TENANT_A)).statusCode).toBe(201);
    expect((await createThing('bw_pat_fb', TENANT_A)).statusCode).toBe(201);
    // The fallback still enforces the limit: the API degrades, it does not stop limiting.
    expect((await createThing('bw_pat_fb', TENANT_A)).statusCode).toBe(429);
    const degraded = await registry.getSingleMetricAsString('rate_limit_degraded_total');
    expect(degraded).toMatch(/rate_limit_degraded_total 3/);
  });
});
