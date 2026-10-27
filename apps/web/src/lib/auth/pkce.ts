// PKCE (RFC 7636, S256), state, nonce and the post-login redirect allowlist (IAM-002, #334).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const RANDOM_BYTES = 32;
const MAX_RETURN_TO_LENGTH = 2048;
const DEFAULT_RETURN_TO = '/';
// Sentinel origin used only to prove a path stays on the console's own origin when resolved.
const PROBE_ORIGIN = 'http://return-to.invalid';

/** 256 bits of CSPRNG output, base64url (43 characters: a valid RFC 7636 verifier). */
export function randomToken(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/** `BASE64URL(SHA256(verifier))`, the S256 code challenge. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Constant-time string equality (hashes first, so unequal lengths do not short-circuit). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/** Backslash (browsers treat it as `/`) and ASCII control characters (header and URL smuggling). */
function isForbiddenChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return char === '\\' || code <= LAST_CONTROL_CODE || code === DELETE_CODE;
}

/**
 * The post-login destination: an internal absolute path only. Anything else (absolute or
 * protocol-relative URLs, backslashes, control characters, the auth routes themselves) becomes `/`,
 * so `returnTo` can never be an open redirect (CWE-601).
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return DEFAULT_RETURN_TO;
  if (raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return DEFAULT_RETURN_TO;
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_RETURN_TO;
  for (const char of raw) {
    if (isForbiddenChar(char)) return DEFAULT_RETURN_TO;
  }
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return DEFAULT_RETURN_TO;
  }
  if (url.origin !== PROBE_ORIGIN) return DEFAULT_RETURN_TO;
  if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/'))
    return DEFAULT_RETURN_TO;
  return `${url.pathname}${url.search}`;
}
