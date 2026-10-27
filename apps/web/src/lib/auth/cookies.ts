// Cookie names and Set-Cookie serialisation for the BFF (IAM-002, #334). Every cookie is `__Host-`
// prefixed (so the browser only accepts it with `Secure`, `Path=/` and no `Domain`), httpOnly,
// Secure and SameSite=Lax. Lax, not Strict: the login cookie must come back on the top-level redirect
// from Keycloak. Attributes are fixed here, so no call site can weaken them.

/** The session cookie: a sealed opaque session id only, never a token. */
export const SESSION_COOKIE = '__Host-bw_session';
/** The short-lived cookie that carries PKCE verifier, state, nonce and returnTo across the redirect. */
export const LOGIN_COOKIE = '__Host-bw_login';

/** `Set-Cookie` header value. `maxAgeSeconds` omitted makes a browser-session cookie; 0 deletes it. */
export function serializeCookie(name: string, value: string, maxAgeSeconds?: number): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(maxAgeSeconds)}`);
  return parts.join('; ');
}

/** `Set-Cookie` header value that makes the browser drop the cookie. */
export function clearCookie(name: string): string {
  return serializeCookie(name, '', 0);
}

/** One cookie's value from a `Cookie` request header, or `undefined`. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
}
