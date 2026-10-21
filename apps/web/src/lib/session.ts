// Server-side session loading for the console (CONSOLE-001, #261). Only Server Components and route
// handlers import this module. The browser holds an httpOnly session cookie that the BFF (IAM) owns;
// this helper forwards it to the BFF session endpoint and keeps only the public identity fields of
// the answer. Tokens never leave the BFF and are never part of the returned `Session`, so nothing
// secret can reach a client component (CONTEXT_PACK §8.7). The tenant is server-derived (§8.6).

import { cookies } from 'next/headers';
import { z } from 'zod';

/** Name of the httpOnly session cookie set by the BFF. */
export const SESSION_COOKIE = 'bw_session';
/** Origin of the BFF that answers session lookups; server-side only, never a `NEXT_PUBLIC_` key. */
const DEFAULT_BFF_ORIGIN = 'http://127.0.0.1:3000';
/** BFF endpoint that resolves the session cookie into the public identity. */
export const SESSION_ENDPOINT_PATH = '/api/auth/session';
const SESSION_TIMEOUT_MS = 5000;
const HTTP_SERVER_ERROR = 500;

const SessionSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.string().min(1), name: z.string() }),
  tenant: z.object({ id: z.string().min(1), slug: z.string().min(1) }),
  roles: z.array(z.string().min(1)),
});

/** The public session: identity, tenant and roles. Deliberately has no token fields. */
export type Session = z.infer<typeof SessionSchema>;

/** The BFF could not be asked (down, timeout, 5xx). Distinct from "no session". */
export class SessionUnavailableError extends Error {
  override readonly name = 'SessionUnavailableError';
  constructor() {
    // Never carries the cookie, the URL query or the upstream body.
    super('The session service is unavailable');
  }
}

export interface SessionDeps {
  /** Reads the raw session cookie value from the incoming request. */
  readonly readCookie: () => Promise<string | undefined>;
  readonly fetch: typeof fetch;
  readonly bffOrigin: string;
}

/**
 * Resolves the session behind `deps`. Missing cookie, 401/403, or a body that does not match the
 * contract all mean "no session" (`null`). A transport failure or 5xx is an outage and throws
 * {@link SessionUnavailableError} so the caller renders an error boundary, not a login redirect.
 */
export async function loadSession(deps: SessionDeps): Promise<Session | null> {
  const cookie = await deps.readCookie();
  if (cookie === undefined || cookie === '') return null;

  let response: Response;
  try {
    response = await deps.fetch(new URL(SESSION_ENDPOINT_PATH, deps.bffOrigin), {
      method: 'GET',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch {
    throw new SessionUnavailableError();
  }

  if (response.status >= HTTP_SERVER_ERROR) throw new SessionUnavailableError();
  if (!response.ok) return null;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const parsed = SessionSchema.safeParse(body);
  if (!parsed.success) return null;
  // Rebuild from the parsed fields so unknown upstream fields (such as tokens) are dropped.
  const { user, tenant, roles } = parsed.data;
  return {
    user: { id: user.id, email: user.email, name: user.name },
    tenant: { id: tenant.id, slug: tenant.slug },
    roles: [...roles],
  };
}

/** Loads the current session on the server; re-validated on every call (no caching across requests). */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const bffOrigin = process.env.BW_WEB_BFF_ORIGIN;
  return loadSession({
    readCookie: () => Promise.resolve(store.get(SESSION_COOKIE)?.value),
    fetch,
    bffOrigin: bffOrigin === undefined || bffOrigin === '' ? DEFAULT_BFF_ORIGIN : bffOrigin,
  });
}
