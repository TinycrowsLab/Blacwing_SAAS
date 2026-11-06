// Server-side client for the Blackwing API (`/v1/demo` routes, mounted with BW_DEMO_MODE=1). Imported by Server
// Components, Server Actions and route handlers only (never by client code): it attaches the internal token and
// the identity of the signed-in administrator.
import type { Viewer } from './auth';

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:13400';
const REQUEST_TIMEOUT_MS = 8000;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_TOO_MANY = 429;

export class ApiError extends Error {
  override readonly name = 'ApiError';
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

function problemOf(status: number, body: unknown): ApiError {
  // The API's rate limit is a busy moment, not a refusal: say so in words a person can act on.
  if (status === HTTP_TOO_MANY)
    return new ApiError(status, 'rate_limited', 'Blackwing is busy for a moment. Your answers are kept; try again in a few seconds.');
  const problem = (typeof body === 'object' && body !== null ? body : {}) as ProblemBody;
  const code = typeof problem.code === 'string' ? problem.code : 'api_error';
  const detail =
    typeof problem.detail === 'string'
      ? problem.detail
      : typeof problem.message === 'string'
        ? problem.message
        : 'The API refused the request.';
  return new ApiError(status, code, detail);
}

/**
 * What every mutation's server action returns (experience spec §10.4): no `?error=` redirects, the page keeps the input
 * and shows `message` with one fix. `status` is the API's HTTP status (409 means someone else already decided).
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly status: number };

const HTTP_BAD_GATEWAY = 502;

/** fetch failed to connect, or gave up waiting: the API was not reached at all. */
const unreachable = (error: unknown): boolean =>
  error instanceof TypeError || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));

/**
 * Runs an API call for a server action and maps any failure to an ActionResult (never throws). Only a failed connection
 * says "Couldn't reach"; anything else on our side says so, never blaming the network for it.
 */
export async function toResult<T>(call: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    if (error instanceof ApiError)
      return { ok: false, code: error.code, message: error.message, status: error.status };
    return unreachable(error)
      ? {
          ok: false,
          code: 'unreachable',
          message: "Couldn't reach Blackwing. Your answers are kept; try again in a moment.",
          status: HTTP_BAD_GATEWAY,
        }
      : {
          ok: false,
          code: 'unexpected',
          message: 'Something went wrong on our side. Your answers are kept; try again in a moment.',
          status: HTTP_BAD_GATEWAY,
        };
  }
}

/** Calls the API as the signed-in user. Throws ApiError with the registered code on refusal. */
export async function callApi<T = unknown>(
  session: Viewer,
  path: string,
  init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
): Promise<T> {
  const token = process.env.BW_DEMO_INTERNAL_TOKEN ?? '';
  if (token === '')
    throw new ApiError(
      HTTP_SERVICE_UNAVAILABLE,
      'api_not_configured',
      'BW_DEMO_INTERNAL_TOKEN is not set.',
    );
  const origin = process.env.BW_DEMO_API_ORIGIN ?? DEFAULT_API_ORIGIN;
  const response = await fetch(new URL(`/v1/demo${path}`, origin), {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      'x-bw-demo-token': token,
      'x-bw-demo-user': session.user.email,
      'x-bw-demo-roles': session.roles.join(','),
      // The Google subject and name, used to create the administrator's directory user on first sign-in.
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
