// Rate limiting against a real Valkey (CONTEXT_PACK §8.6, §9): the Lua token bucket admits no over-count under
// a concurrent burst, keys are tenant-prefixed, and idle buckets expire. Needs Docker (Testcontainers).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ValkeyHandle, withValkey } from '@blackwing/testing/containers';

import { ValkeyRateLimiter } from './valkey-limiter.js';

import type { BucketSpecs } from './bucket.js';

let valkey: ValkeyHandle;
let raw: ReturnType<ValkeyHandle['createClient']>;
let limiter: ValkeyRateLimiter;

const TENANT = '0190f2a0-0000-7000-8000-00000000000a';
const MS_PER_SECOND = 1000;

beforeAll(async () => {
  valkey = await withValkey();
  // A client without the handle's key prefix, to inspect the raw keys the limiter wrote.
  raw = valkey.createClient({ keyPrefix: '' });
  limiter = new ValkeyRateLimiter(valkey.client);
});

afterAll(async () => {
  raw.disconnect();
  await valkey.stop();
});

const specsFor = (token: string, rps: number, burst: number): BucketSpecs => [
  { key: `rl:${TENANT}:${token}:default`, scope: 'principal', rps, burst },
];

describe('ValkeyRateLimiter against Valkey', () => {
  it('admits no more than burst plus the refill over a concurrent burst', async () => {
    const rps = 1;
    const burst = 20;
    const started = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 60 }, () => limiter.consume(specsFor('bw_pat_burst', rps, burst))),
    );
    const elapsedSeconds = (Date.now() - started) / MS_PER_SECOND;
    const admitted = decisions.filter((decision) => decision.allowed).length;
    expect(admitted).toBeGreaterThanOrEqual(burst);
    expect(admitted).toBeLessThanOrEqual(burst + Math.ceil(elapsedSeconds * rps));
  });

  it('keeps the bucket key under the caller tenant prefix and gives it a TTL', async () => {
    await limiter.consume(specsFor('bw_pat_ttl', 10, 20));
    const key = `${valkey.keyPrefix}rl:${TENANT}:bw_pat_ttl:default`;
    expect(await raw.exists(key)).toBe(1);
    expect(await raw.pttl(key)).toBeGreaterThan(0);
  });

  it('denies with the empty bucket scope and a whole-second Retry-After', async () => {
    const specs = specsFor('bw_pat_empty', 1, 1);
    expect((await limiter.consume(specs)).allowed).toBe(true);
    const denied = await limiter.consume(specs);
    expect(denied).toMatchObject({ allowed: false, blockedBy: 'principal', retryAfterSeconds: 1 });
  });

  it('charges nothing from the principal bucket when the tenant ceiling refuses', async () => {
    const principal = {
      key: `rl:${TENANT}:bw_pat_ceiling:default`,
      scope: 'principal' as const,
      rps: 1,
      burst: 5,
    };
    const tenant = {
      key: `rl:${TENANT}:_tenant:ceiling`,
      scope: 'tenant' as const,
      rps: 1,
      burst: 1,
    };
    expect((await limiter.consume([principal, tenant])).allowed).toBe(true);
    expect((await limiter.consume([principal, tenant])).blockedBy).toBe('tenant');
    // The bucket refills in real time between calls, so compare whole tokens: a charge would leave 3.
    const tokens = Number(await raw.hget(`${valkey.keyPrefix}${principal.key}`, 'tokens'));
    expect(Math.floor(tokens)).toBe(4);
  });

  it('isolates tenants that share a token id', async () => {
    const other = '0190f2a0-0000-7000-8000-00000000000b';
    const specs = (tenant: string): BucketSpecs => [
      { key: `rl:${tenant}:bw_pat_shared:default`, scope: 'principal', rps: 1, burst: 1 },
    ];
    expect((await limiter.consume(specs(TENANT))).allowed).toBe(true);
    expect((await limiter.consume(specs(TENANT))).allowed).toBe(false);
    expect((await limiter.consume(specs(other))).allowed).toBe(true);
  });
});
