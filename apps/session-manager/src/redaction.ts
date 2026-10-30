import { isSensitiveKey, REDACTED, redactText } from '@blackwing/logger';

/**
 * Credential fields that are never logged, whatever their name (S8.7): login identifiers and secrets, cookies
 * and session material, and recipe execution bodies (the pitfall the issue names). Matched on the normalised
 * key, so `Set-Cookie` and `set_cookie` are the same field.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'username',
  'password',
  'passwd',
  'otp',
  'totp',
  'mfa',
  'cookie',
  'cookies',
  'setcookie',
  'session',
  'sessiontoken',
  'body',
  'requestbody',
  'responsebody',
  'credential',
  'credentials',
]);

/** Deeper than any real log field; beyond it the subtree is replaced, never walked. */
const MAX_DEPTH = 8;
const MAX_DEPTH_MARKER = '[MaxDepth]';

const normalise = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');

/** True when the value under `key` must never be logged. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(normalise(key)) || isSensitiveKey(key);
}

/**
 * The log redaction serializer. It walks the value and replaces every credential or secret-named field with
 * `[REDACTED]`, scrubs secret-shaped substrings from strings (`redactText`), and keeps everything else. It
 * never mutates its input, so a caller's object is safe to log and then reuse.
 */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return MAX_DEPTH_MARKER;
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = isCredentialKey(key) ? REDACTED : redactLogValue(child, depth + 1);
  }
  return out;
}
