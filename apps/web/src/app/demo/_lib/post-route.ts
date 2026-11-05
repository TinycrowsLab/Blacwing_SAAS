// Shared by the POST route handlers the browser calls (pause, resume, kill, Gate 2 decision): runs the demo API
// call as the signed-in user and hands the answer or the problem back as JSON.
import { DemoApiError, demoApi } from './demo-api';
import { getSession } from '../../../lib/session';

export async function postAsUser(path: string, body: unknown): Promise<Response> {
  const session = await getSession();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  try {
    const answer = await demoApi(session, path, { method: 'POST', body });
    return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof DemoApiError)
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: 'demo_error' }, { status: 500 });
  }
}
