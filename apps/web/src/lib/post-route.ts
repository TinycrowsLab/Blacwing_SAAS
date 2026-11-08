// Shared by the route handlers the browser calls (pause, resume, kill, Gate 2 decision, the sidebar and asset polls):
// runs the API call as the signed-in user and hands the answer or the problem back as JSON.
import { ApiError, callApi } from './api';
import { getViewer } from './auth';

/**
 * Defence in depth on top of the SameSite session cookie: a mutating /api call only comes from this console's own
 * pages. Browsers send Sec-Fetch-Site (and Origin) on every POST; another site, even a sibling localhost port, is
 * refused.
 */
export function crossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return true;
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).host !== (request.headers.get('x-forwarded-host') ?? request.headers.get('host'));
  } catch {
    return true;
  }
}

/**
 * Null when a mutating /api call may proceed; otherwise the refusal to return. `json: true` also requires an
 * application/json body, which a cross-site HTML form can never send without a CORS preflight.
 */
export function refuseMutation(request: Request, options?: { readonly json?: boolean }): Response | null {
  const noStore = { 'cache-control': 'no-store' };
  if (crossSite(request))
    return Response.json({ code: 'cross_site', message: 'This only works from Blackwing itself.' }, { status: 403, headers: noStore });
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (options?.json === true && type !== 'application/json')
    return Response.json({ code: 'unsupported_media_type' }, { status: 415, headers: noStore });
  return null;
}

/** GET as the signed-in user; `shape` parses the API answer (zod) and keeps only what the browser needs. */
export async function getAsUser(path: string, shape: (body: unknown) => unknown): Promise<Response> {
  const session = await getViewer();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  try {
    const answer = shape(await callApi(session, path));
    return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ApiError)
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: 'request_failed' }, { status: 502 });
  }
}

export async function postAsUser(path: string, body: unknown): Promise<Response> {
  const session = await getViewer();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  try {
    const answer = await callApi(session, path, { method: 'POST', body });
    return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ApiError)
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: 'request_failed' }, { status: 500 });
  }
}
