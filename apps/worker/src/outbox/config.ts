import { z } from 'zod';

import { loadConfig, type EnvSource } from '@blackwing/config';

import { positiveInt } from '../config.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_ATTEMPTS = 12;
const MAX_BATCH_SIZE = 1_000;
const MAX_ATTEMPTS = 100;

const outboxRelayEnvSchema = z.object({
  OUTBOX_BATCH_SIZE: positiveInt.pipe(z.number().max(MAX_BATCH_SIZE)).default(DEFAULT_BATCH_SIZE),
  OUTBOX_POLL_INTERVAL_MS: positiveInt.default(DEFAULT_POLL_INTERVAL_MS),
  OUTBOX_MAX_ATTEMPTS: positiveInt.pipe(z.number().max(MAX_ATTEMPTS)).default(DEFAULT_MAX_ATTEMPTS),
});

/** Validated outbox relay settings. */
export interface OutboxRelayConfig {
  /** Rows claimed per poll (`OUTBOX_BATCH_SIZE`, default 100, at most 1000). */
  readonly batchSize: number;
  /** Pause between polls when the last one found nothing to do (`OUTBOX_POLL_INTERVAL_MS`, default 500). */
  readonly pollIntervalMs: number;
  /** Failed deliveries after which a row becomes `failed` (`OUTBOX_MAX_ATTEMPTS`, default 12, at most 100). */
  readonly maxAttempts: number;
}

/** Parses the relay environment. Throws `CONFIG_INVALID` on a bad value. */
export function parseOutboxRelayConfig(source: EnvSource = process.env): OutboxRelayConfig {
  const env = loadConfig(outboxRelayEnvSchema, source);
  return {
    batchSize: env.OUTBOX_BATCH_SIZE,
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  };
}
