import { z } from 'zod';

import { zBool, zSecretUrl, zUrl } from './coerce.js';

/** Deployment environments (CONTEXT_PACK §10). */
export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** pino log levels (CONTEXT_PACK §5), most to least severe, plus `silent`. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Keys every Blackwing process reads. Deliberately minimal: a key belongs here only if every app,
 * including the in-sandbox agent runtime, needs it. Apps compose this with the slices below and their
 * own keys:
 *
 * ```ts
 * const apiEnv = baseEnvSchema.extend({ ...databaseEnvShape, ...valkeyEnvShape, PORT: zPort() });
 * // or: baseEnvSchema.merge(databaseEnvSchema).merge(valkeyEnvSchema)
 * export const config = defineConfig(apiEnv);
 * ```
 *
 * Defaults never weaken security: `NODE_ENV` has no default (a process that does not say where it
 * runs must not boot with dev-only behaviour), and `TLS_VERIFY` defaults to `true`.
 */
export const baseEnvShape = {
  /** Required. No default: guessing `development` would enable dev-only behaviour in production. */
  NODE_ENV: z.enum(NODE_ENVS),
  /** Minimum level `@blackwing/logger` emits. */
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** OTLP endpoint for traces/metrics/logs export. Unset means telemetry export is off. */
  OTEL_EXPORTER_OTLP_ENDPOINT: zUrl({ protocols: ['http:', 'https:'] }).optional(),
  /** Verify TLS certificates of outbound connections. Defaults to `true`; never default this off. */
  TLS_VERIFY: zBool().default(true),
} as const;

export const baseEnvSchema = z.object(baseEnvShape);
export type BaseEnv = z.output<typeof baseEnvSchema>;

/**
 * PostgreSQL connection (`DATABASE_URL`). The whole URL is a secret: it usually carries the password.
 * Not part of the base: the agent runtime must never receive database credentials (§8.7).
 */
export const databaseEnvShape = {
  DATABASE_URL: zSecretUrl({ protocols: ['postgres:', 'postgresql:'] }),
} as const;
export const databaseEnvSchema = z.object(databaseEnvShape);
export type DatabaseEnv = z.output<typeof databaseEnvSchema>;

/**
 * Valkey connection for BullMQ, cache and Streams (§5). The slice is named after the fixed stack
 * component; the key keeps the conventional `REDIS_URL` name (FOUND-007) because Valkey speaks the Redis
 * protocol and its clients take a `redis:`/`rediss:` URL. Secret for the same reason as `DATABASE_URL`.
 */
export const valkeyEnvShape = {
  REDIS_URL: zSecretUrl({ protocols: ['redis:', 'rediss:'] }),
} as const;
export const valkeyEnvSchema = z.object(valkeyEnvShape);
export type ValkeyEnv = z.output<typeof valkeyEnvSchema>;
