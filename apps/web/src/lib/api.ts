// Server-side client for the Blackwing API (`/v1/demo` routes, mounted with BW_DEMO_MODE=1). Imported by Server
// Components, Server Actions and route handlers only (never by client code): it attaches the internal token and
// the identity of the signed-in administrator.
import type { Viewer } from './auth';

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:13400';
const REQUEST_TIMEOUT_MS = 8000;
const HTTP_SERVICE_UNAVAILABLE = 503;

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
