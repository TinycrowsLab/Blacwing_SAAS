import { createHash } from 'node:crypto';

import { canonicalize } from '../concurrency/etag.js';

/** SHA-256 as lower-case hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** `sha256(Idempotency-Key)`: the raw key (client-chosen, possibly guessable) is never stored. */
export function hashIdempotencyKey(key: string): string {
  return sha256Hex(key);
}

/**
 * The Valkey key for one request: `idem:{tenantId}:{route}:{sha256(key)}` (API-008 requirement 2).
 * The tenant is part of the key, so two tenants can never share a record (§8.6). `route` is the matched
 * route template (`/v1/runs`), not the concrete URL, and `keyHash` is already a hash.
 */
export function idempotencyStorageKey(tenantId: string, route: string, keyHash: string): string {
  return `idem:${tenantId}:${route}:${keyHash}`;
}

/** The body as a canonical string: JSON with sorted keys, so member order does not change the fingerprint. */
export function canonicalBody(raw: Uint8Array | string | undefined): string {
  if (raw === undefined || raw.length === 0) return '';
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  try {
    return `json:${canonicalize(JSON.parse(text))}`;
  } catch {
    // Not JSON (or not valid UTF-8 JSON): the exact bytes decide.
    return `raw:${sha256Hex(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw)}`;
  }
}

/** Query parameters sorted by name then value, so their order does not change the fingerprint. */
function canonicalQuery(query: string): string {
  if (query === '') return '';
  const pairs = [...new URLSearchParams(query)];
  pairs.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  return new URLSearchParams(pairs).toString();
}

export interface FingerprintInput {
  readonly method: string;
  /** Request path without the query string. */
  readonly path: string;
  /** Raw query string (no leading `?`). */
  readonly query: string;
  /** The raw request body captured by the adapter (`rawBody: true`). */
  readonly rawBody: Uint8Array | string | undefined;
}

/**
 * `sha256(method + path + canonicalBody)` (API-008 requirement 4). The query string is included so
 * `?dry_run=true` and `?dry_run=false` do not look like the same request; fields are newline-separated so
 * no two different (method, path, query, body) tuples concatenate to the same input.
 */
export function requestFingerprint(input: FingerprintInput): string {
  return sha256Hex(
    [
      input.method.toUpperCase(),
      input.path,
      canonicalQuery(input.query),
      canonicalBody(input.rawBody),
    ].join('\n'),
  );
}
