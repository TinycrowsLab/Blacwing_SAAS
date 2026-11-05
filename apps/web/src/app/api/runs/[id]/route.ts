// The browser's poll for the live timeline. Proxies to the API as the signed-in user.
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

const MAX_SEQ = 1_000_000;

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const raw = Number(new URL(request.url).searchParams.get('afterSeq') ?? '0');
  const afterSeq = Number.isInteger(raw) && raw >= 0 && raw <= MAX_SEQ ? raw : 0;
  try {
    const body = await callApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=${afterSeq}`);
    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ApiError)
      return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: 'request_failed' }, { status: 500 });
  }
}
