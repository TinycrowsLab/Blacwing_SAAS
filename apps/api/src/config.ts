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
import { MIN_SECRET_LENGTH } from '@blackwing/crypto';

import {
  STEPUP_ACR_MAX_CHARS,
  STEPUP_DEFAULT_ACR,
  STEPUP_DEFAULT_MAX_AGE_S,
  STEPUP_MAX_AGE_LIMIT_S,
} from './authorisations/step-up.js';

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

/** GraphQL query limits (API-009, #61): depth, complexity and alias count per operation. */
const DEFAULT_API_GQL_MAX_DEPTH = 10;
const DEFAULT_API_GQL_MAX_COMPLEXITY = 1000;
const DEFAULT_API_GQL_MAX_ALIASES = 50;

/** Health probes (API-011, #63). */
const DEFAULT_API_HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_API_HEALTH_CACHE_MS = 1000;

/** Run event streams over SSE (#65). */
const DEFAULT_API_SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_API_SSE_MAX_DURATION_MS = 3_600_000;
const DEFAULT_API_SSE_MAX_REPLAY = 1_000;
const DEFAULT_API_SSE_MAX_CONN_PER_TENANT = 100;

/** Idempotency-Key handling (API-008, #60). */
const DEFAULT_API_IDEMPOTENCY_TTL_S = 86_400;
const DEFAULT_API_IDEMPOTENCY_LOCK_TTL_S = 120;
const DEFAULT_API_IDEMPOTENCY_MAX_BODY_BYTES = 65_536;

/** Input-manifest uploads (SCOPE-006): 25 MiB per object, a 5-minute grant, 50 objects per manifest. */
const DEFAULT_SCOPE_UPLOAD_MAX_BYTES = 26_214_400;
const DEFAULT_SCOPE_PRESIGN_TTL_MS = 300_000;
const DEFAULT_SCOPE_MANIFEST_MAX_OBJECTS = 50;
/** A grant that lives longer than an hour is a standing credential, not an upload window. */
const SCOPE_PRESIGN_TTL_MS_MAX = 3_600_000;

/** Keycloak JWT validation (#335): the audience this API accepts and the clock-skew leeway. */
const DEFAULT_API_JWT_AUDIENCE = 'blackwing-api';
const MAX_API_JWT_AUDIENCE_CHARS = 256;
const DEFAULT_API_JWT_LEEWAY_SECONDS = 60;
/** The platform-operator realm's API audience (#838). */
const DEFAULT_OPERATOR_API_JWT_AUDIENCE = 'operator-api';
const MAX_API_JWT_LEEWAY_SECONDS = 300;
/** JWKS cache: trust window, minimum gap between refetches, and the fetch timeout. */
const DEFAULT_API_JWKS_TTL_MS = 600_000;
const DEFAULT_API_JWKS_REFETCH_COOLDOWN_MS = 30_000;
const DEFAULT_API_JWKS_TIMEOUT_MS = 3000;
/** Self-service signup (TENANT-004). */
const DEFAULT_SIGNUP_TOKEN_TTL_HOURS = 24;
const DEFAULT_SIGNUP_DEFAULT_REGION = 'eu-west-1';
const DEFAULT_SIGNUP_EMAIL_MAX_PER_HOUR = 5;

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

const SIGNUP_TOKEN_TTL_HOURS_MAX = 168;
/** A link that stays valid for more than a week is a standing credential, not a verification. */
const signupTokenHours = positiveRate.refine(
  (hours) => hours <= SIGNUP_TOKEN_TTL_HOURS_MAX,
  `must be at most ${String(SIGNUP_TOKEN_TTL_HOURS_MAX)} hours`,
);

const positiveDuration = zDurationMs().refine((ms) => ms > 0, 'must be greater than zero');

/** Whole seconds from 0 to the maximum leeway (0 allowed: strict clocks). */
const leewaySeconds = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})$/, 'must be a whole number of seconds')
  .transform(Number)
  .refine((value) => value <= MAX_API_JWT_LEEWAY_SECONDS, 'must be at most 300 seconds');

/** A BFF session secret: the same value the web app seals its cookies with (IAM-002). */
const sessionSecret = zSecret().refine(
  (value) => value.length >= MIN_SECRET_LENGTH,
  `must be at least ${String(MIN_SECRET_LENGTH)} characters`,
);

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
  /** Largest input-manifest object a grant accepts, in bytes (SCOPE-006). */
  SCOPE_UPLOAD_MAX_BYTES: byteCount.default(DEFAULT_SCOPE_UPLOAD_MAX_BYTES),
  /** How long a presigned upload grant stays usable, as a duration such as `300s` (SCOPE-006). */
  SCOPE_PRESIGN_TTL: positiveDuration
    .refine((ms) => ms <= SCOPE_PRESIGN_TTL_MS_MAX, 'must be at most 1h')
    .default(DEFAULT_SCOPE_PRESIGN_TTL_MS),
  /** Most objects one input manifest may hold, counting registered uploads (SCOPE-006). */
  SCOPE_MANIFEST_MAX_OBJECTS: positiveRate.default(DEFAULT_SCOPE_MANIFEST_MAX_OBJECTS),
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
  /** Heartbeat comment interval that keeps an idle run event stream open through intermediaries (#65). */
  API_SSE_HEARTBEAT_MS: positiveDuration.default(DEFAULT_API_SSE_HEARTBEAT_MS),
  /** An event stream closes with `event: timeout` after this long, so a forgotten stream cannot pin a connection. */
  API_SSE_MAX_DURATION_MS: positiveDuration.default(DEFAULT_API_SSE_MAX_DURATION_MS),
  /** A resume replays at most this many events; further missed events answer `event: resync` (#65). */
  API_SSE_MAX_REPLAY: positiveRate.default(DEFAULT_API_SSE_MAX_REPLAY),
  /** Open run event streams per tenant on one instance; the next one answers `429`. */
  API_SSE_MAX_CONN_PER_TENANT: positiveRate.default(DEFAULT_API_SSE_MAX_CONN_PER_TENANT),
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
  /** Deepest field nesting a GraphQL operation may have; deeper operations get `query_too_complex`. */
  API_GQL_MAX_DEPTH: positiveRate.default(DEFAULT_API_GQL_MAX_DEPTH),
  /** Estimated cost ceiling of a GraphQL operation (list sizes multiply their children). */
  API_GQL_MAX_COMPLEXITY: positiveRate.default(DEFAULT_API_GQL_MAX_COMPLEXITY),
  /** Most field aliases one GraphQL operation may carry (alias flooding guard). */
  API_GQL_MAX_ALIASES: positiveRate.default(DEFAULT_API_GQL_MAX_ALIASES),
  /** How long a signup verification link works, in whole hours (TENANT-004). */
  SIGNUP_TOKEN_TTL_HOURS: signupTokenHours.default(DEFAULT_SIGNUP_TOKEN_TTL_HOURS),
  /** Data region a self-service tenant is pinned to. */
  SIGNUP_DEFAULT_REGION: z
    .string()
    .regex(/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/, 'must look like an AWS region code')
    .default(DEFAULT_SIGNUP_DEFAULT_REGION),
  /** Most verification mails one address may ask for per hour; further requests are answered 202 but send nothing. */
  SIGNUP_EMAIL_MAX_PER_HOUR: positiveRate.default(DEFAULT_SIGNUP_EMAIL_MAX_PER_HOUR),
  /**
   * Console page the verification link opens (`<url>#token=<token>`). Unset: `<first WEB_ORIGIN>/signup/verify`.
   * The token travels in the fragment, so it reaches neither access logs nor `Referer` headers.
   */
  SIGNUP_VERIFY_URL: zUrl({ protocols: ['http:', 'https:'] }).optional(),
  /**
   * Only persisted queries run (a known sha256 id; raw documents are refused). Unset, it is on in production and
   * off in development, so raw queries keep working locally.
   */
  API_GQL_PERSISTED_ONLY: zBool().optional(),
  /** Release version and commit echoed by `/health`. Neither is a secret. */
  API_VERSION: z.string().min(1).default('0.0.0'),
  API_COMMIT: z.string().min(1).default('unknown'),
  /**
   * Keycloak realm issuer (`https` outside development). Unset, Keycloak JWTs are refused (fail closed).
   */
  KEYCLOAK_ISSUER_URL: zUrl({ protocols: ['http:', 'https:'] }).optional(),
  /** The audience a Keycloak token must carry (`aud`). */
  API_JWT_AUDIENCE: z
    .string()
    .min(1)
    .max(MAX_API_JWT_AUDIENCE_CHARS)
    .default(DEFAULT_API_JWT_AUDIENCE),
  /** Clock-skew tolerance for `exp`, `nbf` and `iat` (#335). */
  API_JWT_LEEWAY_SECONDS: leewaySeconds.default(DEFAULT_API_JWT_LEEWAY_SECONDS),
  /** How long a fetched JWKS is trusted before a refresh. */
  API_JWKS_TTL_MS: zDurationMs().default(DEFAULT_API_JWKS_TTL_MS),
  /** Minimum gap between JWKS fetches (bounds refetches on unknown `kid`s). */
  API_JWKS_REFETCH_COOLDOWN_MS: zDurationMs().default(DEFAULT_API_JWKS_REFETCH_COOLDOWN_MS),
  API_JWKS_TIMEOUT_MS: positiveDuration.default(DEFAULT_API_JWKS_TIMEOUT_MS),
  /**
   * The BFF's session secret (the value IAM-002 seals session cookies with). Unset, BFF session cookies are refused.
   * `BW_WEB_SESSION_SECRET_PREVIOUS` still opens cookies during a rotation and never seals.
   */
  BW_WEB_SESSION_SECRET: sessionSecret.optional(),
  BW_WEB_SESSION_SECRET_PREVIOUS: sessionSecret.optional(),
  /**
   * Platform-operator realm issuer (#838, `blackwing-operators`). Unset, operator tokens are refused (fail closed).
   * Operator tokens are never accepted as tenant tokens and the reverse, because the realm, audience and keys differ.
   */
  OPERATOR_KEYCLOAK_ISSUER_URL: zUrl({ protocols: ['http:', 'https:'] }).optional(),
  /** The audience an operator token must carry (`aud`). */
  OPERATOR_API_JWT_AUDIENCE: z
    .string()
    .min(1)
    .max(MAX_API_JWT_AUDIENCE_CHARS)
    .default(DEFAULT_OPERATOR_API_JWT_AUDIENCE),
  /**
   * The platform-operator BFF's session secret (#838). A key separate from the tenant secret, so an operator cookie
   * never opens as a tenant one. Unset, operator session cookies are refused.
   */
  BW_OPERATOR_SESSION_SECRET: sessionSecret.optional(),
  BW_OPERATOR_SESSION_SECRET_PREVIOUS: sessionSecret.optional(),
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
  /**
   * Step-up for approving a standing authorisation (AUTHZ-008): the largest age, in seconds, of the approver's last
   * authentication, and the authentication context class it must assert (the realm's strong acr, IAM-009).
   */
  AUTHZ_STEPUP_MAX_AGE_S: z.coerce
    .number()
    .int()
    .min(1)
    .max(STEPUP_MAX_AGE_LIMIT_S)
    .default(STEPUP_DEFAULT_MAX_AGE_S),
  AUTHZ_STEPUP_ACR: z.string().trim().min(1).max(STEPUP_ACR_MAX_CHARS).default(STEPUP_DEFAULT_ACR),
} as const;

export const apiEnvSchema = z.object(apiEnvShape);
export type ApiConfig = z.output<typeof apiEnvSchema>;

/** Parses and freezes the API configuration; throws `ConfigValidationError` (key names only) on bad input. */
export function loadApiConfig(source?: EnvSource): Readonly<ApiConfig> {
  return loadConfig(apiEnvSchema, source);
}
