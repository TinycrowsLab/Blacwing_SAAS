// DEMO-STORY server-side client for the demo API (`/v1/demo`, BW_DEMO_MODE=1 only). Imported by Server Components,
// Server Actions and route handlers only (never by client code): it attaches the internal token and the identity
// of the Keycloak session. Demo only.
import type { Session } from '../../../lib/session';

const DEFAULT_DEMO_API_ORIGIN = 'http://127.0.0.1:13400';
const REQUEST_TIMEOUT_MS = 8000;
const HTTP_SERVICE_UNAVAILABLE = 503;

export class DemoApiError extends Error {
  override readonly name = 'DemoApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ProblemBody {
  readonly code?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
}

function problemOf(status: number, body: unknown): DemoApiError {
  const problem = (typeof body === 'object' && body !== null ? body : {}) as ProblemBody;
  const code = typeof problem.code === 'string' ? problem.code : 'demo_api_error';
  const detail =
    typeof problem.detail === 'string'
      ? problem.detail
      : typeof problem.message === 'string'
        ? problem.message
        : 'The demo API refused the request.';
  return new DemoApiError(status, code, detail);
}

/** Calls the demo API as the signed-in user. Throws DemoApiError with the registered code on refusal. */
export async function demoApi<T = unknown>(
  session: Session,
  path: string,
  init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
): Promise<T> {
  const token = process.env.BW_DEMO_INTERNAL_TOKEN ?? '';
  if (token === '')
    throw new DemoApiError(
      HTTP_SERVICE_UNAVAILABLE,
      'demo_not_configured',
      'BW_DEMO_INTERNAL_TOKEN is not set.',
    );
  const origin = process.env.BW_DEMO_API_ORIGIN ?? DEFAULT_DEMO_API_ORIGIN;
  const response = await fetch(new URL(`/v1/demo${path}`, origin), {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'x-bw-demo-token': token,
      'x-bw-demo-user': session.user.email,
      'x-bw-demo-roles': session.roles.join(','),
      // The Keycloak subject and name, used only to provision a first-time Google sign-in (demo mode).
      'x-bw-demo-sub': session.user.id,
      'x-bw-demo-name': session.user.name,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  const parsed: unknown = text === '' ? {} : JSON.parse(text);
  if (!response.ok) throw problemOf(response.status, parsed);
  return parsed as T;
}
