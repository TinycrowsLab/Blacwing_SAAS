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

/**
 * Code default for `API_PORT` (API-001, #53). The shared dev host map runs the API on 13400 because the
 * web console owns 3000 there; `.env.example` sets that.
 */
export const DEFAULT_API_PORT = 3000;
export const DEFAULT_API_HOST = '0.0.0.0';
/** 1 MiB. Larger request bodies are rejected with `413` before any handler runs. */
export const DEFAULT_API_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_API_SHUTDOWN_GRACE_MS = 10_000;
/** Deepest JSON nesting a request body may have (API-002, #54). */
export const DEFAULT_API_MAX_JSON_DEPTH = 32;

/** Rate limiting (mechanism fallback values; TENANT-011 supplies per-plan values). */
const DEFAULT_API_RATE_LIMIT_RPS = 10;
const DEFAULT_API_RATE_LIMIT_BURST = 20;

/** Health probes (API-011, #63). */
const DEFAULT_API_HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_API_HEALTH_CACHE_MS = 1000;

/** Idempotency-Key handling (API-008, #60). */
const DEFAULT_API_IDEMPOTENCY_TTL_S = 86_400;
const DEFAULT_API_IDEMPOTENCY_LOCK_TTL_S = 120;
const DEFAULT_API_IDEMPOTENCY_MAX_BODY_BYTES = 65_536;

const byteCount = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/, 'must be a positive integer number of bytes')
  .transform(Number);

/** Whole seconds, at least 1. */
const seconds = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer number of seconds')
  .transform(Number);

const positiveRate = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$/, 'must be a positive integer')
  .transform(Number);

const positiveDuration = zDurationMs().refine((ms) => ms > 0, 'must be greater than zero');

/** Browser origin: scheme, host and optional port only (what a CORS `Origin` header carries). */
const origin = zUrl({ protocols: ['http:', 'https:'] }).refine((value) => {
  const url = new URL(value);
  return url.pathname === '/' && url.search === '' && url.hash === '' && !value.endsWith('/');
}, 'must be an origin (scheme://host[:port]) without a path or trailing slash');

/** Keycloak realm, client id and OpenBao path length bounds (IAM-002). */
const KEYCLOAK_NAME_MAX = 255;
const KEYCLOAK_PATH_MAX = 512;

/** Environment of `apps/api` (API-001, #53). Validated at boot; any problem refuses to start. */
export const apiEnvShape = {
  ...baseEnvShape,
  API_PORT: zPort().default(DEFAULT_API_PORT),
  API_HOST: z.string().min(1).default(DEFAULT_API_HOST),
  API_BODY_LIMIT_BYTES: byteCount.default(DEFAULT_API_BODY_LIMIT_BYTES),
  /** Bodies nested deeper than this are rejected with `422` (deep-nesting abuse guard, API-002). */
  API_MAX_JSON_DEPTH: byteCount.default(DEFAULT_API_MAX_JSON_DEPTH),
  /** Honour `X-Forwarded-*` only when true. The API normally sits behind the platform load balancer. */
  API_TRUST_PROXY: zBool().default(true),
  /** How long in-flight requests may take to finish after SIGTERM/SIGINT. */
  API_SHUTDOWN_GRACE_MS: positiveDuration.default(DEFAULT_API_SHUTDOWN_GRACE_MS),
  /** Per-dependency health check budget; a slower dependency is reported `down`, never awaited. */
  API_HEALTH_CHECK_TIMEOUT_MS: positiveDuration.default(DEFAULT_API_HEALTH_CHECK_TIMEOUT_MS),
  /** How long a health result is reused, so a burst of probes does not hammer the dependencies. */
  API_HEALTH_CACHE_MS: zDurationMs().default(DEFAULT_API_HEALTH_CACHE_MS),
  /** Include the (non-critical) Temporal check in readiness and the detailed report. */
  API_HEALTH_CHECK_TEMPORAL: zBool().default(true),
  /**
   * HMAC key that signs pagination cursors (API-005). Optional so the API boots without list routes;
   * the cursor codec refuses a missing or short (< 32 chars) key (fail closed).
   */
  API_CURSOR_SECRET: zSecret().optional(),
  /** How long a stored `Idempotency-Key` result is replayed (API-008). */
  API_IDEMPOTENCY_TTL_S: seconds.default(DEFAULT_API_IDEMPOTENCY_TTL_S),
  /**
   * How long an `in_progress` marker blocks duplicates. A crash between the work and the stored result
   * lets a retry proceed once it expires (API-008).
   */
  API_IDEMPOTENCY_LOCK_TTL_S: seconds.default(DEFAULT_API_IDEMPOTENCY_LOCK_TTL_S),
  /** Largest response body stored for replay; a bigger one is flagged and replays as `409 idempotency_result_too_large`. */
  API_IDEMPOTENCY_MAX_BODY_BYTES: byteCount.default(DEFAULT_API_IDEMPOTENCY_MAX_BODY_BYTES),
  /**
   * Rate-limit fallback (RATE_LIMIT_DEFAULT_RPS / RATE_LIMIT_BURST): the sustained requests per second and burst
   * of every bucket that no configured per-plan value (TENANT-011) covers.
   */
  RATE_LIMIT_DEFAULT_RPS: positiveRate.default(DEFAULT_API_RATE_LIMIT_RPS),
  RATE_LIMIT_BURST: positiveRate.default(DEFAULT_API_RATE_LIMIT_BURST),
  /** Release version and commit echoed by `/health`. Neither is a secret. */
  API_VERSION: z.string().min(1).default('0.0.0'),
  API_COMMIT: z.string().min(1).default('unknown'),
  /**
   * Comma-separated browser origins allowed by CORS (the web console). Required with no default: an
   * unset value must never silently allow, or silently block, every origin.
   */
  WEB_ORIGIN: zCsv(origin).refine((list) => list.length > 0, 'must list at least one origin'),
  /**
   * Keycloak Admin API for organisation provisioning (IAM-002). Optional so the API boots without it; the
   * organisations service refuses to start unless all four are set (see `keycloak/settings.ts`). The client
   * secret is never an env value: it is read by reference from OpenBao at `KEYCLOAK_ORG_ADMIN_SECRET_PATH`.
   */
  KEYCLOAK_ADMIN_URL: zUrl({ protocols: ['http:', 'https:'] }).optional(),
  KEYCLOAK_ADMIN_REALM: z.string().min(1).max(KEYCLOAK_NAME_MAX).optional(),
  KEYCLOAK_ORG_ADMIN_CLIENT_ID: z.string().min(1).max(KEYCLOAK_NAME_MAX).optional(),
  KEYCLOAK_ORG_ADMIN_SECRET_PATH: z.string().min(1).max(KEYCLOAK_PATH_MAX).optional(),
} as const;

export const apiEnvSchema = z.object(apiEnvShape);
export type ApiConfig = z.output<typeof apiEnvSchema>;

/** Parses and freezes the API configuration; throws `ConfigValidationError` (key names only) on bad input. */
export function loadApiConfig(source?: EnvSource): Readonly<ApiConfig> {
  return loadConfig(apiEnvSchema, source);
}
