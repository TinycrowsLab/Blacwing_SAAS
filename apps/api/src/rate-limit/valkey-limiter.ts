import { z } from 'zod';

import type { BucketDecision, BucketSpecs } from './bucket.js';
import type { RateLimiter } from './limiter.js';

/**
 * The slice of an ioredis client the limiter uses (structural, so the API needs no driver dependency and tests
 * can pass a fake). The ioredis `Redis` client satisfies it.
 */
export interface ValkeyRateLimitClient {
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * Atomic token bucket for every bucket of one check (KEYS = bucket keys, ARGV = rps, burst per key). Time is the
 * Valkey server clock (`TIME`), never the caller's. All buckets are read, refilled and, only when every one holds
 * a token, charged in one script run, so concurrent requests cannot over-admit. The arithmetic mirrors
 * `evaluateBuckets` in `bucket.ts`. Replies: [allowed, limit, remaining, resetMs, retryMs, firstEmptyIndex].
 */
const TOKEN_BUCKET_SCRIPT = `
local now_t = redis.call('TIME')
local now = tonumber(now_t[1]) * 1000 + math.floor(tonumber(now_t[2]) / 1000)
local n = #KEYS
local tokens, rps, burst = {}, {}, {}
local first_empty = 0
local retry_ms = 0
for i = 1, n do
  rps[i] = tonumber(ARGV[2 * i - 1])
  burst[i] = tonumber(ARGV[2 * i])
  local stored = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local prior = tonumber(stored[1]) or burst[i]
  local since = tonumber(stored[2]) or now
  local refilled = math.min(burst[i], prior + math.max(0, now - since) * rps[i] / 1000)
  tokens[i] = refilled
  if refilled < 1 then
    if first_empty == 0 then first_empty = i end
    retry_ms = math.max(retry_ms, (1 - refilled) * 1000 / rps[i])
  end
end
local allowed = 0
if first_empty == 0 then allowed = 1 end
local tightest = 1
local reset_ms = 0
for i = 1, n do
  if allowed == 1 then tokens[i] = tokens[i] - 1 end
  redis.call('HSET', KEYS[i], 'tokens', string.format('%.17g', tokens[i]), 'ts', now)
  redis.call('PEXPIRE', KEYS[i], math.ceil(burst[i] * 1000 / rps[i]) + 1000)
  if tokens[i] < tokens[tightest] then tightest = i end
  reset_ms = math.max(reset_ms, (burst[i] - tokens[i]) * 1000 / rps[i])
end
return { allowed, burst[tightest], math.floor(tokens[tightest]), math.ceil(reset_ms), math.ceil(retry_ms), first_empty }`;

const MS_PER_SECOND = 1000;

/** Raised when the reply is not the script's shape: the limiter is treated as unavailable (degraded). */
export class RateLimitReplyError extends Error {
  constructor() {
    super('rate limit script returned an unexpected reply');
    this.name = 'RateLimitReplyError';
  }
}

const replySchema = z.tuple([
  z.number().int().min(0).max(1),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
  z.number().int().min(0),
]);

/** Valkey adapter of {@link RateLimiter}: one atomic script per check, on keys the caller tenant-prefixed. */
export class ValkeyRateLimiter implements RateLimiter {
  readonly #client: ValkeyRateLimitClient;

  constructor(client: ValkeyRateLimitClient) {
    this.#client = client;
  }

  async consume(specs: BucketSpecs): Promise<BucketDecision> {
    const reply = await this.#client.eval(
      TOKEN_BUCKET_SCRIPT,
      specs.length,
      ...specs.map((spec) => spec.key),
      ...specs.flatMap((spec) => [String(spec.rps), String(spec.burst)]),
    );
    const parsed = replySchema.safeParse(reply);
    if (!parsed.success) throw new RateLimitReplyError();
    const [allowed, limit, remaining, resetMs, retryMs, firstEmpty] = parsed.data;
    const blocked = specs[firstEmpty - 1];
    return {
      allowed: allowed === 1,
      limit,
      remaining,
      resetSeconds: Math.ceil(resetMs / MS_PER_SECOND),
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryMs / MS_PER_SECOND)),
      ...(allowed === 1 || blocked === undefined ? {} : { blockedBy: blocked.scope }),
    };
  }
}
