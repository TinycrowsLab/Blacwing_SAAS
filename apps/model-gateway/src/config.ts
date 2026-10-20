import { z } from 'zod';

import {
  baseEnvShape,
  type EnvSource,
  loadConfig,
  zDurationMs,
  zPort,
  zSecret,
  zUrl,
} from '@blackwing/config';

/** Provider adapters the gateway can route to. GATEWAY-003..006 add the rest of the set. */
export const PROVIDER_IDS = ['anthropic'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEFAULT_GATEWAY_PORT = 8081;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BODY_BYTES = 10_485_760;

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
} as const;

export const gatewayEnvSchema = z.object(gatewayEnvShape);
export type GatewayConfig = z.output<typeof gatewayEnvSchema>;

/** Parses and freezes the gateway configuration; throws `ConfigValidationError` (key names only) on bad input. */
export function loadGatewayConfig(source?: EnvSource): Readonly<GatewayConfig> {
  return loadConfig(gatewayEnvSchema, source);
}
