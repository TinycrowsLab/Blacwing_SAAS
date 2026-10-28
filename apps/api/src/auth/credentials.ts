import { AuthInvalidTokenError } from './errors.js';

/**
 * Credential detection (#335). Exactly one credential is selected per request, by shape:
 *   - `Authorization: Bearer bw_pat_…` / `bw_ci_…` → the opaque token path (RBAC-007);
 *   - any other `Authorization: Bearer …` → a Keycloak JWT;
 *   - no `Authorization` header, a `__Host-bw_session` cookie → the BFF session.
 * An `Authorization` header that is present but malformed is refused and never falls through to the cookie.
 */

const SESSION_COOKIE_NAME = '__Host-bw_session';
const OPAQUE_TOKEN_PREFIXES: readonly string[] = ['bw_pat_', 'bw_ci_'];

/** Larger headers are refused before they are parsed (bounded parse). */
export const MAX_HEADER_BYTES = 8192;
const MAX_TOKEN_CHARS = 4096;
const BEARER = /^bearer ([A-Za-z0-9._~+/=-]+)$/i;

export type Credential =
  | { readonly kind: 'none' }
  | { readonly kind: 'opaque-bearer'; readonly token: string }
  | { readonly kind: 'jwt'; readonly token: string }
  | { readonly kind: 'session-cookie'; readonly cookie: string };

/** The subset of request headers the guard reads. */
export interface CredentialHeaders {
  readonly authorization?: string | string[] | undefined;
  readonly cookie?: string | string[] | undefined;
}

/** The one credential a request carries. Throws `AuthInvalidTokenError` for a malformed or oversized header. */
export function credentialOf(headers: CredentialHeaders): Credential {
  if (headers.authorization !== undefined) return bearerCredential(headers.authorization);
  const cookie = sessionCookieOf(headers.cookie);
  return cookie === undefined ? { kind: 'none' } : { kind: 'session-cookie', cookie };
}

function bearerCredential(header: string | string[]): Credential {
  if (typeof header !== 'string' || header.length > MAX_HEADER_BYTES) {
    throw new AuthInvalidTokenError('malformed Authorization header');
  }
  const token = BEARER.exec(header)?.[1];
  if (token === undefined || token.length > MAX_TOKEN_CHARS) {
    throw new AuthInvalidTokenError('malformed Authorization header');
  }
  if (OPAQUE_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return { kind: 'opaque-bearer', token };
  }
  return { kind: 'jwt', token };
}

function sessionCookieOf(header: string | string[] | undefined): string | undefined {
  return cookieValueOf(header, SESSION_COOKIE_NAME);
}

/**
 * The one value of cookie `name` in a `Cookie` header, or `undefined`. Bounded and strict: a malformed or oversized
 * header is refused, and two cookies of the same name are ambiguous and refused rather than one being picked.
 * Shared by every BFF cookie (tenant session, platform-operator session), so the parsing is one code path (#838).
 */
export function cookieValueOf(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  if (header === undefined) return undefined;
  if (typeof header !== 'string' || header.length > MAX_HEADER_BYTES) {
    throw new AuthInvalidTokenError('malformed Cookie header');
  }
  let found: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    // Two cookies of one name are ambiguous: refuse rather than pick one.
    if (found !== undefined) throw new AuthInvalidTokenError('duplicate session cookie');
    found = part.slice(eq + 1).trim();
  }
  if (found === undefined || found === '') return undefined;
  if (found.length > MAX_TOKEN_CHARS) throw new AuthInvalidTokenError('malformed session cookie');
  return found;
}
