import { AppError } from '@blackwing/errors';

/** Environment of the internal secret resolve API (SECRETS-006). */
export interface ResolveConfig {
  /** `SECRET_RESOLVE_SERVICE_TOKEN_KEY`: HMAC key of the service tokens; at least 32 characters. */
  readonly serviceTokenKey: string;
  /** `SECRET_RESOLVE_ALLOWED_CIDRS`: pod CIDRs or addresses of the calling services (never the sandbox CIDR). */
  readonly allowedPeerCidrs: readonly string[];
  /** `SECRET_RESOLVE_CACHE_TTL_MS`: in-memory plaintext cache lifetime; `0` (default) is off. */
  readonly cacheTtlMs: number;
  /** `SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE`: resolves per service per minute. */
  readonly rateLimit: { readonly limit: number; readonly windowMs: number };
}

export const DEFAULT_RESOLVE_RATE_LIMIT_PER_MINUTE = 1200;
/** Longest plaintext cache lifetime a deployment may configure. */
export const MAX_RESOLVE_CACHE_TTL_MS = 300_000;
const MIN_KEY_LENGTH = 32;
const WINDOW_MS = 60_000;

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d{1,9}$/.test(raw.trim())) {
    throw new AppError('CONFIG_INVALID', `${name} must be a non-negative integer`);
  }
  return Number(raw.trim());
}

/** Parses the resolve API environment; a bad value is a configuration defect (fail closed, key names only). */
export function resolveConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ResolveConfig {
  const serviceTokenKey = env.SECRET_RESOLVE_SERVICE_TOKEN_KEY ?? '';
  if (serviceTokenKey.length < MIN_KEY_LENGTH) {
    throw new AppError(
      'CONFIG_INVALID',
      'SECRET_RESOLVE_SERVICE_TOKEN_KEY must be at least 32 characters',
    );
  }
  const allowedPeerCidrs = (env.SECRET_RESOLVE_ALLOWED_CIDRS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (allowedPeerCidrs.length === 0) {
    throw new AppError(
      'CONFIG_INVALID',
      'SECRET_RESOLVE_ALLOWED_CIDRS must list the calling services',
    );
  }
  const cacheTtlMs = integer(env, 'SECRET_RESOLVE_CACHE_TTL_MS', 0);
  if (cacheTtlMs > MAX_RESOLVE_CACHE_TTL_MS) {
    throw new AppError('CONFIG_INVALID', 'SECRET_RESOLVE_CACHE_TTL_MS must be at most 300000');
  }
  const limit = integer(
    env,
    'SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE',
    DEFAULT_RESOLVE_RATE_LIMIT_PER_MINUTE,
  );
  if (limit < 1) {
    throw new AppError('CONFIG_INVALID', 'SECRET_RESOLVE_RATE_LIMIT_PER_MINUTE must be positive');
  }
  return {
    serviceTokenKey,
    allowedPeerCidrs,
    cacheTtlMs,
    rateLimit: { limit, windowMs: WINDOW_MS },
  };
}
