import { describe, expect, it } from 'vitest';

import {
  RateLimitReplyError,
  ValkeyRateLimiter,
  type ValkeyRateLimitClient,
} from './valkey-limiter.js';

import type { BucketSpecs } from './bucket.js';

interface Call {
  readonly script: string;
  readonly numKeys: number;
  readonly args: readonly string[];
}

function fakeClient(reply: unknown): { client: ValkeyRateLimitClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      eval: (script, numKeys, ...args) => {
        calls.push({ script, numKeys, args });
        return Promise.resolve(reply);
      },
    },
  };
}

const specs: BucketSpecs = [
  { key: 'rl:tenant-a:tok-1:default', scope: 'principal', rps: 10, burst: 20 },
  { key: 'rl:tenant-a:_tenant:default', scope: 'tenant', rps: 50, burst: 100 },
];

describe('ValkeyRateLimiter', () => {
  it('sends one script call with the tenant-prefixed keys and rps/burst pairs in order', async () => {
    const { client, calls } = fakeClient([1, 20, 19, 0, 0, 0]);
    await new ValkeyRateLimiter(client).consume(specs);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.numKeys).toBe(2);
    expect(calls[0]?.args).toEqual([
      'rl:tenant-a:tok-1:default',
      'rl:tenant-a:_tenant:default',
      '10',
      '20',
      '50',
      '100',
    ]);
  });

  it('takes time from the Valkey server clock, never from the caller', async () => {
    const { client, calls } = fakeClient([1, 20, 19, 0, 0, 0]);
    await new ValkeyRateLimiter(client).consume(specs);
    expect(calls[0]?.script).toContain("redis.call('TIME')");
    expect(calls[0]?.script).not.toMatch(/Date\.now|os\.time/);
  });

  it('maps an admitted reply to an allowed decision with headers figures', async () => {
    const { client } = fakeClient([1, 20, 19, 0, 0, 0]);
    expect(await new ValkeyRateLimiter(client).consume(specs)).toEqual({
      allowed: true,
      limit: 20,
      remaining: 19,
      resetSeconds: 0,
      retryAfterSeconds: 0,
    });
  });

  it('maps a denied reply, naming the empty bucket and rounding waits up to whole seconds', async () => {
    // First empty bucket is index 2 (the tenant ceiling); 500 ms to the next token; reset in 1.5 s.
    const { client } = fakeClient([0, 100, 0, 1500, 500, 2]);
    expect(await new ValkeyRateLimiter(client).consume(specs)).toEqual({
      allowed: false,
      limit: 100,
      remaining: 0,
      resetSeconds: 2,
      retryAfterSeconds: 1,
      blockedBy: 'tenant',
    });
  });

  it.each([
    ['a non-array reply', 'OK'],
    ['a short reply', [1, 20, 19]],
    ['a non-integer field', [1, 20, 19.5, 0, 0, 0]],
    ['an allowed flag other than 0 or 1', [2, 20, 19, 0, 0, 0]],
    ['a negative wait', [0, 20, 0, 0, -1, 1]],
  ])('refuses %s as unavailable rather than guessing', async (_label, reply) => {
    const { client } = fakeClient(reply);
    await expect(new ValkeyRateLimiter(client).consume(specs)).rejects.toBeInstanceOf(
      RateLimitReplyError,
    );
  });

  it('lets a client failure propagate, so the guard can fall back', async () => {
    const client: ValkeyRateLimitClient = {
      eval: () => Promise.reject(new Error('connection refused')),
    };
    await expect(new ValkeyRateLimiter(client).consume(specs)).rejects.toThrow(
      'connection refused',
    );
  });
});
