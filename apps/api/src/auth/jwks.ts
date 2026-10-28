import { createLocalJWKSet, errors as joseErrors, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import { JwksUnavailableError } from './errors.js';

/** A JWKS document is small; a larger body is refused before it is parsed. */
export const MAX_JWKS_BYTES = 262_144;
const MAX_JWKS_KEYS = 64;

const jwksDocumentSchema = z.object({
  keys: z.array(z.looseObject({ kty: z.string().min(1) })).max(MAX_JWKS_KEYS),
});

export interface JwksCacheOptions {
  /** The realm's JWKS endpoint (`<issuer>/protocol/openid-connect/certs`). */
  readonly url: string;
  /** How long a fetched key set is trusted before a refresh is attempted. */
  readonly ttlMs: number;
  /** Minimum gap between two fetches. Bounds refetches on unknown `kid`s (a negative cache, against JWKS DoS). */
  readonly refetchCooldownMs: number;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly fetch?: typeof fetch;
  /** Counts every fetch attempt (`jwks_refetch_total`). */
  readonly onFetch?: () => void;
}

/** Verification-key lookup for `jose`, backed by a cached key set that survives an IdP outage. */
export interface JwksCache {
  readonly resolve: JWTVerifyGetKey;
}

/**
 * Keeps the realm's signing keys in memory. A missing `kid` triggers one refetch, at most once per cooldown,
 * so a rotated key validates at once and a stream of forged `kid`s cannot hammer the IdP. When the IdP is
 * unreachable the last good key set keeps serving; with nothing cached, lookups fail closed.
 */
export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const fetchJson = options.fetch ?? fetch;
  let keySet: JWTVerifyGetKey | undefined;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  async function fetchKeys(): Promise<void> {
    const response = await fetchJson(options.url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`JWKS endpoint answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_JWKS_BYTES) throw new Error('JWKS document is too large');
    const document = jwksDocumentSchema.parse(JSON.parse(text));
    keySet = createLocalJWKSet({ keys: document.keys });
    fetchedAt = options.now();
  }

  /** One fetch at a time; callers share the in-flight attempt. */
  function refresh(): Promise<void> {
    if (inFlight === undefined) {
      lastAttempt = options.now();
      options.onFetch?.();
      inFlight = fetchKeys().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  function cooledDown(): boolean {
    return options.now() - lastAttempt >= options.refetchCooldownMs;
  }

  async function currentKeySet(): Promise<JWTVerifyGetKey> {
    const stale = options.now() - fetchedAt >= options.ttlMs;
    if (inFlight !== undefined) {
      // Join the attempt already under way: a cold cache must not answer while its fetch is pending.
      await inFlight.catch(() => undefined);
    } else if ((keySet === undefined || stale) && cooledDown()) {
      try {
        await refresh();
      } catch (error) {
        // Keep serving the cached set; only a cold cache is an outage.
        if (keySet === undefined) throw new JwksUnavailableError(error);
      }
    }
    if (keySet === undefined) throw new JwksUnavailableError(new Error('no key set was fetched'));
    return keySet;
  }

  const resolve: JWTVerifyGetKey = async (header, token) => {
    const set = await currentKeySet();
    try {
      return await set(header, token);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey) || !cooledDown()) throw error;
      // An unknown `kid`: the key may have rotated. Refetch once and retry with the new set.
      await refresh().catch(() => undefined);
      return (keySet ?? set)(header, token);
    }
  };

  return { resolve };
}
