import { z } from 'zod';

import { type EnvSource, loadConfig, zDurationMs } from '@blackwing/config';

const MIN_SECRET_LENGTH = 32;
export const DEFAULT_BROKER_IDENTITY_HEADER = 'x-bw-mesh-identity';
export const DEFAULT_BROKER_RATE_LIMIT_PER_MINUTE = 600;
export const DEFAULT_BROKER_RATE_LIMIT_WINDOW_MS = 60_000;

/** Comma-separated list where an empty value means "none" (and so refuses everything, fail closed). */
const list = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );

/** Environment of the Run Broker (API-014, #66). */
export const brokerEnvSchema = z.object({
  /** HMAC key for `bwrun_` tokens, shared with the issuer. At least 32 characters. */
  BROKER_RUN_TOKEN_SECRET: z.string().min(MIN_SECRET_LENGTH, 'must be at least 32 characters'),
  /** Source CIDRs of the sandbox run network. Empty refuses every request. */
  BROKER_ALLOWED_CIDRS: list,
  /** Header the mesh/ingress sets to the caller's workload identity. */
  BROKER_MESH_IDENTITY_HEADER: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/)
    .default(DEFAULT_BROKER_IDENTITY_HEADER),
  /** Accepted identity values. Empty refuses every request. */
  BROKER_MESH_IDENTITIES: list,
  /** Requests per run session per window (rate limiting is by run token, not user token). */
  BROKER_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_BROKER_RATE_LIMIT_PER_MINUTE),
  BROKER_RATE_LIMIT_WINDOW_MS: zDurationMs().default(DEFAULT_BROKER_RATE_LIMIT_WINDOW_MS),
});
export type BrokerConfig = z.output<typeof brokerEnvSchema>;

/** Parses and freezes the broker configuration; throws `ConfigValidationError` (key names only). */
export function loadBrokerConfig(source?: EnvSource): Readonly<BrokerConfig> {
  return loadConfig(brokerEnvSchema, source);
}
