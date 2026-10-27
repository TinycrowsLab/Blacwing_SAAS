import { describe, expect, it } from 'vitest';

import { InProcessRateLimiter } from './limiter.js';

import type { BucketSpecs } from './bucket.js';

const T0 = 1_700_000_000_000;

function clock(start = T0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const one = (key: string, rps = 1, burst = 2): BucketSpecs => [
  { key, scope: 'principal', rps, burst },
];

describe('InProcessRateLimiter', () => {
  it('admits a burst, denies the next request, and admits again after the refill', async () => {
    const time = clock();
    const limiter = new InProcessRateLimiter({ now: time.now });
    expect((await limiter.consume(one('k'))).allowed).toBe(true);
    expect((await limiter.consume(one('k'))).allowed).toBe(true);
    const denied = await limiter.consume(one('k'));
    expect(denied).toMatchObject({ allowed: false, retryAfterSeconds: 1, blockedBy: 'principal' });
    time.advance(1000);
    expect((await limiter.consume(one('k'))).allowed).toBe(true);
  });

  it('keeps buckets of different keys independent', async () => {
    const limiter = new InProcessRateLimiter({ now: clock().now });
    await limiter.consume(one('rl:t1:a:default'));
    await limiter.consume(one('rl:t1:a:default'));
    expect((await limiter.consume(one('rl:t1:a:default'))).allowed).toBe(false);
    expect((await limiter.consume(one('rl:t2:a:default'))).allowed).toBe(true);
  });

  it('drops idle buckets at the cap so memory stays bounded without evicting busy ones', async () => {
    const time = clock();
    const limiter = new InProcessRateLimiter({ now: time.now, maxBuckets: 2 });
    await limiter.consume(one('a'));
    await limiter.consume(one('b'));
    time.advance(5000); // both have refilled to full: idle, so forgetting them changes nothing
    expect((await limiter.consume(one('c'))).allowed).toBe(true);
  });

  it('refuses a new key at the cap while busy buckets exist (an attacker cannot evict honest ones)', async () => {
    const limiter = new InProcessRateLimiter({ now: clock().now, maxBuckets: 2 });
    await limiter.consume(one('a'));
    await limiter.consume(one('a'));
    await limiter.consume(one('b'));
    await limiter.consume(one('b'));
    const refused = await limiter.consume(one('c'));
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
    // The busy buckets keep their state: still denied, not reset by the flood.
    expect((await limiter.consume(one('a'))).allowed).toBe(false);
  });

  it('a clock jump backwards does not refill a drained bucket', async () => {
    const time = clock();
    const limiter = new InProcessRateLimiter({ now: time.now });
    await limiter.consume(one('k'));
    await limiter.consume(one('k'));
    time.advance(-60_000);
    expect((await limiter.consume(one('k'))).allowed).toBe(false);
  });
});
