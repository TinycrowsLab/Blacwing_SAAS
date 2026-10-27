import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_KEY,
  RateLimit,
  RateLimitExempt,
  RateLimitPolicy,
} from './policy.js';

const DEFAULTS = { rps: 10, burst: 20 };

/** The metadata a method decorator stores on the method it decorates (Nest reads it the same way). */
function metadataOf(decorator: MethodDecorator & ClassDecorator, key: symbol): unknown {
  const method = (): void => undefined;
  decorator({}, 'handler', { value: method });
  const value: unknown = Reflect.getMetadata(key, method);
  return value;
}

describe('RateLimit decorator', () => {
  it('stores the route class and overrides', () => {
    expect(metadataOf(RateLimit({ routeClass: 'auth', rps: 1, burst: 3 }), RATE_LIMIT_KEY)).toEqual(
      {
        routeClass: 'auth',
        rps: 1,
        burst: 3,
      },
    );
  });

  it('refuses a malformed route class or non-positive value when the module loads', () => {
    expect(() => RateLimit({ routeClass: 'Auth Class' })).toThrow();
    expect(() => RateLimit({ rps: 0 })).toThrow();
    expect(() => RateLimit({ burst: 1.5 })).toThrow();
    expect(() => RateLimit({ unknown: 1 } as never)).toThrow();
  });

  it('marks a route exempt', () => {
    expect(metadataOf(RateLimitExempt(), RATE_LIMIT_EXEMPT_KEY)).toBe(true);
  });
});

describe('RateLimitPolicy', () => {
  it('uses the env fallback when no configured value exists', () => {
    const policy = new RateLimitPolicy({ defaults: DEFAULTS });
    expect(policy.limitsFor({ scope: 'principal', routeClass: 'default', tenantId: 't' })).toEqual(
      DEFAULTS,
    );
  });

  it('uses the configured value (TENANT-011) before the fallback', () => {
    const policy = new RateLimitPolicy({
      defaults: DEFAULTS,
      config: {
        limitsFor: ({ scope, routeClass }) =>
          scope === 'tenant' && routeClass === 'auth' ? { rps: 2, burst: 5 } : undefined,
      },
    });
    expect(policy.limitsFor({ scope: 'tenant', routeClass: 'auth', tenantId: 't' })).toEqual({
      rps: 2,
      burst: 5,
    });
    expect(policy.limitsFor({ scope: 'tenant', routeClass: 'default', tenantId: 't' })).toEqual(
      DEFAULTS,
    );
  });

  it('applies a route override to the principal and IP scopes, never to the tenant ceiling', () => {
    const policy = new RateLimitPolicy({ defaults: DEFAULTS });
    const override = { routeClass: 'auth', rps: 1, burst: 3 };
    expect(
      policy.limitsFor({ scope: 'principal', routeClass: 'auth', tenantId: 't' }, override),
    ).toEqual({
      rps: 1,
      burst: 3,
    });
    expect(
      policy.limitsFor({ scope: 'ip', routeClass: 'auth', tenantId: undefined }, override),
    ).toEqual({
      rps: 1,
      burst: 3,
    });
    expect(
      policy.limitsFor({ scope: 'tenant', routeClass: 'auth', tenantId: 't' }, override),
    ).toEqual(DEFAULTS);
  });

  it('lets an override set only one of the two values', () => {
    const policy = new RateLimitPolicy({ defaults: DEFAULTS });
    expect(
      policy.limitsFor({ scope: 'principal', routeClass: 'x', tenantId: 't' }, { rps: 2 }),
    ).toEqual({
      rps: 2,
      burst: 20,
    });
  });
});
