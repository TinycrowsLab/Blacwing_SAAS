import { createHash } from 'node:crypto';

/**
 * Argument normalisation for loop detection (MENTOR-001, #420). Two tool calls that differ only by volatile
 * noise (timestamps, nonces, request ids) or by Unicode compatibility forms of the same text must hash
 * alike, and a secret in an argument must never reach the hash input or the window in plaintext (§8.7).
 */

/** Written in place of any value under a secret-looking key. The raw value is never kept. */
export const REDACTED_ARG = '[REDACTED]';
/** Written in place of structure nested deeper than {@link MAX_ARG_DEPTH}. */
const TRUNCATED_ARG = '[TRUNCATED]';
/** Written for values with no JSON form (bigint, symbol, function). Fixed, so it never leaks content. */
const UNSERIALISABLE_ARG = '[UNSERIALISABLE]';
/** Depth cap: a hostile, self-nesting argument cannot exhaust the stack. */
const MAX_ARG_DEPTH = 32;

/** Canonical key names (lowercase, no `_`, `-` or spaces) whose values change on every call. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'at',
  'createdat',
  'date',
  'now',
  'nonce',
  'requestid',
  'correlationid',
  'spanid',
  'time',
  'timestamp',
  'traceid',
  'ts',
  'updatedat',
]);

/** Canonical key fragments whose values are secrets. Matched as substrings. */
const SECRET_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'passwd',
  'password',
  'privatekey',
  'secret',
  'token',
] as const;

/** Key canonical form: NFKC, lowercase, separators removed, so `Request_ID` and `requestId` agree. */
function canonicalKey(key: string): string {
  return key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/** Free text: NFKC so compatibility variants (fullwidth, ligatures) collapse, then whitespace collapsed. */
function normaliseString(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Recursively rebuilds a JSON-like value with volatile keys dropped, secrets redacted and keys sorted. */
function normaliseValue(value: unknown, depth: number): unknown {
  if (depth > MAX_ARG_DEPTH) return TRUNCATED_ARG;
  if (typeof value === 'string') return normaliseString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => normaliseValue(item, depth + 1));
  if (typeof value === 'object') {
    const entries: [string, unknown][] = [];
    for (const [key, raw] of Object.entries(value)) {
      const canon = canonicalKey(key);
      if (VOLATILE_KEYS.has(canon)) continue;
      const secret = SECRET_KEY_FRAGMENTS.some((frag) => canon.includes(frag));
      entries.push([canon, secret ? REDACTED_ARG : normaliseValue(raw, depth + 1)]);
    }
    // Keys use their canonical form and are sorted, so key order, case and separators cannot change the digest.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  // undefined maps to null; bigint, symbol and functions have no JSON form and hash to a fixed marker.
  return typeof value === 'undefined' ? null : UNSERIALISABLE_ARG;
}

/**
 * Stable digest of a tool call's arguments after normalisation. Only the digest is kept by the detector:
 * the raw payload is never stored.
 */
export function hashToolArgs(args: unknown): string {
  const canonical = JSON.stringify(normaliseValue(args, 0) ?? null);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
