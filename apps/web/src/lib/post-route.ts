// Shared by the route handlers the browser calls (pause, resume, kill, Gate 2 decision, the sidebar and asset polls):
// runs the API call as the signed-in user and hands the answer or the problem back as JSON.
import { ApiError, callApi } from './api';
import { getViewer } from './auth';

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
