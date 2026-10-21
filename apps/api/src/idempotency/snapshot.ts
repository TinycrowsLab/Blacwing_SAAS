import { isSensitiveKey, REDACTED, redactText } from '@blackwing/logger';

import type { StoredResult } from './record.js';

const HTTP_UNAUTHORIZED = 401; // credentials may be fixed on the retry
const HTTP_FORBIDDEN = 403; // permissions may change
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_CONFLICT = 409; // state-dependent: the other writer may be gone on the retry
const HTTP_LOCKED = 423;
const HTTP_TOO_EARLY = 425;
const HTTP_TOO_MANY_REQUESTS = 429; // the retry is expected to succeed

/** Statuses that are never stored although they are 4xx: they depend on who asks or on timing, not on the request. */
const TRANSIENT_CLIENT_ERRORS: ReadonlySet<number> = new Set([
  HTTP_UNAUTHORIZED,
  HTTP_FORBIDDEN,
  HTTP_REQUEST_TIMEOUT,
  HTTP_CONFLICT,
  HTTP_LOCKED,
  HTTP_TOO_EARLY,
  HTTP_TOO_MANY_REQUESTS,
]);

const FIRST_SUCCESS = 200;
const LAST_SUCCESS = 299;
const FIRST_CLIENT_ERROR = 400;
const LAST_CLIENT_ERROR = 499;

/**
 * Only `2xx` and deterministic `4xx` are stored and replayed (API-008 requirement 6). A `5xx`, a
 * redirect and the transient `4xx` above are never cached, so a genuine retry runs the work again.
 */
export function isCacheableStatus(status: number): boolean {
  if (status >= FIRST_SUCCESS && status <= LAST_SUCCESS) return true;
  return (
    status >= FIRST_CLIENT_ERROR &&
    status <= LAST_CLIENT_ERROR &&
    !TRANSIENT_CLIENT_ERRORS.has(status)
  );
}

/**
 * Response headers kept for replay. Everything else (`x-request-id`, `date`, cookies, `set-cookie`,
 * rate-limit counters, `retry-after`) describes the replayed exchange, not the original result.
 */
export const REPLAYED_HEADERS: readonly string[] = Object.freeze([
  'content-type',
  'content-language',
  'content-location',
  'etag',
  'location',
]);

/** The allowlisted headers of a reply, lower-cased, as plain strings. */
export function headerSubset(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') out[name] = value;
    else if (typeof value === 'number') out[name] = String(value);
  }
  return out;
}

const MAX_REDACTION_DEPTH = 64;

/** Walks parsed JSON, replacing values under sensitive keys and secret-shaped strings (§8.7). */
function redactValue(value: unknown, depth: number, hits: { count: number }): unknown {
  if (typeof value === 'string') {
    const redacted = redactText(value);
    if (redacted !== value) hits.count += 1;
    return redacted;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_REDACTION_DEPTH) {
    hits.count += 1;
    return REDACTED;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, hits));
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      hits.count += 1;
      out[key] = REDACTED;
    } else out[key] = redactValue(member, depth + 1, hits);
  }
  return out;
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const TEXT_TYPE = /^text\//i;

export type SnapshotOutcome =
  | { readonly kind: 'stored'; readonly result: StoredResult; readonly redactions: number }
  | { readonly kind: 'omitted'; readonly reason: 'too_large' | 'unsupported_type' };

export interface SnapshotInput {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The serialized payload as handed to `onSend`. */
  readonly payload: unknown;
  readonly maxBodyBytes: number;
}

/**
 * Turns the outgoing response into what is stored. Secrets are redacted before anything is stored
 * (§8.7): sensitive JSON members become `[REDACTED]`, so a replay of a response that carried a one-time
 * secret returns the placeholder, never the secret. Only JSON and text bodies can be redacted, so any
 * other type is omitted; so is a body above `maxBodyBytes` (measured after redaction).
 */
export function buildSnapshot(input: SnapshotInput): SnapshotOutcome {
  const { status, headers, payload, maxBodyBytes } = input;
  const contentType = headers['content-type'] ?? '';
  const text =
    typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf8')
        : payload === null || payload === undefined
          ? ''
          : undefined;
  const bodyless = text === '';
  if (
    text === undefined ||
    (!bodyless && !JSON_TYPE.test(contentType) && !TEXT_TYPE.test(contentType))
  )
    return { kind: 'omitted', reason: 'unsupported_type' };

  let body = text;
  let redactions = 0;
  if (!bodyless) {
    const hits = { count: 0 };
    if (JSON_TYPE.test(contentType)) {
      try {
        const redacted = redactValue(JSON.parse(text), 0, hits);
        // Keep the original bytes unless something was actually redacted.
        if (hits.count > 0) body = JSON.stringify(redacted);
      } catch {
        return { kind: 'omitted', reason: 'unsupported_type' };
      }
    } else {
      body = redactText(text);
      if (body !== text) hits.count += 1;
    }
    redactions = hits.count;
  }
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes)
    return { kind: 'omitted', reason: 'too_large' };
  return {
    kind: 'stored',
    result: { kind: 'stored', status, headers: { ...headers }, body },
    redactions,
  };
}
