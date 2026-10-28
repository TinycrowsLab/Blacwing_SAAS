// HTTP glue for the BFF route handlers (IAM-002, #334): CSRF checks, response builders with
// `Cache-Control: no-store`, and the guard that turns an unexpected failure into a body-less 500
// (nothing from the failure reaches the client) while logging it without any token.

import { safeEqual } from './pkce.js';

/** Header the page echoes from `/api/auth/session` on every state-changing BFF call. */
export const CSRF_HEADER = 'x-bw-csrf';

const HTTP_OK = 200;
const HTTP_SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_UNAUTHORIZED = 401;
const RETRY_AFTER_SECONDS = '2';

/**
 * CSRF defence for BFF mutations (CWE-352): the per-session secret must come back in a header a
 * cross-site form cannot set, and a browser-sent `Origin` must be the console's own. SameSite=Lax on
 * the session cookie is the first line; this is the second.
 */
export function csrfValid(
  request: Request,
  record: { readonly csrf: string },
  consoleOrigin: string,
): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== consoleOrigin) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const token = request.headers.get(CSRF_HEADER);
  return token !== null && safeEqual(token, record.csrf);
}

export interface ResponseOptions {
  readonly status?: number;
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

function build(body: BodyInit | null, options: ResponseOptions): Response {
  const headers = new Headers({ 'cache-control': 'no-store', ...options.headers });
  for (const cookie of options.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(body, { status: options.status ?? HTTP_OK, headers });
}

export function jsonResponse(body: unknown, options: ResponseOptions = {}): Response {
  return build(JSON.stringify(body), {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
}

export function redirectResponse(location: string, options: ResponseOptions = {}): Response {
  return build(null, {
    ...options,
    status: options.status ?? HTTP_SEE_OTHER,
    headers: { location, ...options.headers },
  });
}

export function unauthenticated(cookies: readonly string[] = []): Response {
  return jsonResponse({ error: 'unauthenticated' }, { status: HTTP_UNAUTHORIZED, cookies });
}

/** A body-less answer (the back-channel logout response, #336): no cache, nothing to read. */
export function emptyResponse(status: number): Response {
  return build(null, { status });
}

export function badRequest(): Response {
  return jsonResponse({ error: 'invalid_request' }, { status: HTTP_BAD_REQUEST });
}

export function forbidden(): Response {
  return jsonResponse({ error: 'csrf' }, { status: HTTP_FORBIDDEN });
}

export function unavailable(): Response {
  return jsonResponse(
    { error: 'unavailable' },
    { status: HTTP_SERVICE_UNAVAILABLE, headers: { 'retry-after': RETRY_AFTER_SECONDS } },
  );
}
