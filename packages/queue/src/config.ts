import { z } from 'zod';

import { type EnvSource, loadConfig, zSecretUrl } from '@blackwing/config';

/** Valkey URL when `REDIS_URL` is unset (the dev compose service name). */
export const DEFAULT_REDIS_URL = 'redis://valkey:6379';
/** Root of every BullMQ key: `<prefix>:<tenantId>:<queue>:...` (CONTEXT_PACK §8.6). */
export const DEFAULT_BULL_PREFIX = 'bw';
/** Jobs a worker runs at once (`BULL_WORKER_CONCURRENCY`). */
export const DEFAULT_WORKER_CONCURRENCY = 10;
const MAX_WORKER_CONCURRENCY = 256;

const bullEnvSchema = z.object({
  REDIS_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }).optional(),
  BULL_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, 'BULL_PREFIX must be 1-32 lowercase letters, digits or dashes')
    .optional(),
  BULL_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(MAX_WORKER_CONCURRENCY).optional(),
});

/** Validated BullMQ settings. */
export interface BullConfig {
  /** Valkey URL (`REDIS_URL`, default {@link DEFAULT_REDIS_URL}). A secret: it may carry the password. */
  readonly redisUrl: string;
  /** Key root (`BULL_PREFIX`, default {@link DEFAULT_BULL_PREFIX}). */
  readonly prefix: string;
  /** Worker concurrency (`BULL_WORKER_CONCURRENCY`, default {@link DEFAULT_WORKER_CONCURRENCY}, 1 to 256). */
  readonly workerConcurrency: number;
}

/** Parses the queue environment. Throws `CONFIG_INVALID` on a bad value. */
export function parseBullConfig(source: EnvSource = process.env): BullConfig {
  const env = loadConfig(bullEnvSchema, source);
  return {
    redisUrl: env.REDIS_URL ?? DEFAULT_REDIS_URL,
    prefix: env.BULL_PREFIX ?? DEFAULT_BULL_PREFIX,
    workerConcurrency: env.BULL_WORKER_CONCURRENCY ?? DEFAULT_WORKER_CONCURRENCY,
  };
}
