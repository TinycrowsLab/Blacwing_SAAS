import { describe, expect, it } from 'vitest';

import { resolveConfigFromEnv } from './resolve-config.js';

const ok = {
  SECRET_RESOLVE_SERVICE_TOKEN_KEY: 'k'.repeat(32),
  SECRET_RESOLVE_ALLOWED_CIDRS: '10.20.0.0/16, 10.30.1.4',
};

describe('resolveConfigFromEnv', () => {
  it('defaults the cache off and the rate limit to 1200 a minute', () => {
    expect(resolveConfigFromEnv(ok)).toEqual({
      serviceTokenKey: 'k'.repeat(32),
      allowedPeerCidrs: ['10.20.0.0/16', '10.30.1.4'],
      cacheTtlMs: 0,
      rateLimit: { limit: 1200, windowMs: 60_000 },
    });
  });

  it('reads the cache TTL and rate limit', () => {
    const config = resolveConfigFromEnv({
      ...ok,
      SECRET_RESOLVE_CACHE_TTL_MS: '5000',
      SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE: '30',
    });
    expect(config.cacheTtlMs).toBe(5000);
    expect(config.rateLimit.limit).toBe(30);
  });

  it.each([
    [{ ...ok, SECRET_RESOLVE_SERVICE_TOKEN_KEY: 'short' }, /SERVICE_TOKEN_KEY/],
    [{ ...ok, SECRET_RESOLVE_SERVICE_TOKEN_KEY: undefined }, /SERVICE_TOKEN_KEY/],
    [{ ...ok, SECRET_RESOLVE_ALLOWED_CIDRS: '' }, /ALLOWED_CIDRS/],
    [{ ...ok, SECRET_RESOLVE_ALLOWED_CIDRS: undefined }, /ALLOWED_CIDRS/],
    [{ ...ok, SECRET_RESOLVE_CACHE_TTL_MS: '-1' }, /CACHE_TTL_MS/],
    [{ ...ok, SECRET_RESOLVE_CACHE_TTL_MS: 'soon' }, /CACHE_TTL_MS/],
    [{ ...ok, SECRET_RESOLVE_CACHE_TTL_MS: '300001' }, /CACHE_TTL_MS/],
    [{ ...ok, SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE: '0' }, /RATE_LIMIT/],
  ])('refuses a bad environment %#', (env, message) => {
    expect(() => resolveConfigFromEnv(env)).toThrowError(message);
  });

  it('never puts the key in the error', () => {
    const secretish = 'z'.repeat(8);
    let message = '';
    try {
      resolveConfigFromEnv({ ...ok, SECRET_RESOLVE_SERVICE_TOKEN_KEY: secretish });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('SERVICE_TOKEN_KEY');
    expect(message).not.toContain(secretish);
  });
});
