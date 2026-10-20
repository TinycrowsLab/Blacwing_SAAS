import { z } from 'zod';

import {
  baseEnvShape,
  type EnvSource,
  loadConfig,
  zBool,
  zCsv,
  zDurationMs,
  zPort,
  zSecret,
  zUrl,
} from '@blackwing/config';

/** Provider adapters the gateway can route to. GATEWAY-003..006 add the rest of the set. */
export const PROVIDER_IDS = ['anthropic', 'dev_subscription'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEFAULT_GATEWAY_PORT = 8081;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BODY_BYTES = 10_485_760;
/** How often the dev subscription provider repeats its WARN banner while the process runs. */
export const DEFAULT_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS = 300_000;

/** Deployment environments; the same set the other Blackwing services accept for `BW_ENV`. */
export const BW_ENVIRONMENTS = ['dev', 'test', 'staging', 'production'] as const;
export type BwEnvironment = (typeof BW_ENVIRONMENTS)[number];

const byteCount = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/, 'must be a positive integer number of bytes')
  .transform(Number);

const positiveDuration = zDurationMs().refine((ms) => ms > 0, 'must be greater than zero');

/** Environment of `apps/model-gateway` (GATEWAY-001, #404). */
export const gatewayEnvShape = {
  ...baseEnvShape,
  /** Interface to bind. The container listens on every interface; the network policy limits who reaches it. */
  GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
  GATEWAY_PORT: zPort().default(DEFAULT_GATEWAY_PORT),
  /** Time allowed for upstream response headers, and the longest silence between two streamed chunks. */
  GATEWAY_UPSTREAM_TIMEOUT_MS: positiveDuration.default(DEFAULT_UPSTREAM_TIMEOUT_MS),
  /** Largest accepted request body; larger bodies get an Anthropic `request_too_large` error. */
  GATEWAY_MAX_BODY_BYTES: byteCount.default(DEFAULT_MAX_BODY_BYTES),
  GATEWAY_DEFAULT_PROVIDER: z.enum(PROVIDER_IDS).default('anthropic'),
  /**
   * Base URL of the Anthropic-compatible upstream. Required with no default, so a misconfigured process
   * never silently reaches a real provider: dev and tests point it at a local mock upstream.
   */
  GATEWAY_ANTHROPIC_BASE_URL: zUrl({ protocols: ['http:', 'https:'] }),
  /** Provider credential injected downstream. Lives only in the gateway, never in a sandbox (§4.1, §8.7). */
  GATEWAY_ANTHROPIC_API_KEY: zSecret().optional(),
  /**
   * Deployment environment. Optional for the gateway, with no default: anything that is not exactly `dev`
   * (including unset) keeps the dev subscription provider refused.
   */
  BW_ENV: z.enum(BW_ENVIRONMENTS).optional(),
  /**
   * POC-ONLY (#883): explicit opt-in for the `dev_subscription` provider, which uses the host developer's
   * local Claude Code login. Honoured only with `BW_ENV=dev`; the gateway refuses to boot otherwise.
   */
  GATEWAY_DEV_SUBSCRIPTION_ENABLED: zBool().default(false),
  /** Claude Code credential file read by the dev provider; defaults to `~/.claude/.credentials.json`. */
  GATEWAY_DEV_SUBSCRIPTION_CREDENTIALS_FILE: z.string().min(1).optional(),
  /** Dev/demo tenants allowed through the dev provider; every other tenant is denied. */
  GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS: zCsv(z.uuid()).optional(),
  /**
   * SHA-256 (hex) of the one dev `bwk_` virtual key accepted until per-session keys (#405) land. Only the
   * hash is configured, never the key.
   */
  GATEWAY_DEV_VIRTUAL_KEY_SHA256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256')
    .optional(),
  GATEWAY_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS: positiveDuration.default(
    DEFAULT_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS,
  ),
} as const;

export const gatewayEnvSchema = z.object(gatewayEnvShape);
export type GatewayConfig = z.output<typeof gatewayEnvSchema>;

/** Parses and freezes the gateway configuration; throws `ConfigValidationError` (key names only) on bad input. */
export function loadGatewayConfig(source?: EnvSource): Readonly<GatewayConfig> {
  return loadConfig(gatewayEnvSchema, source);
}
