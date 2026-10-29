// DEMO-STORY: the browser's poll for the live timeline. Proxies to the demo API as the signed-in user.
import { getSession } from '../../../../../lib/session';
import { DemoApiError, demoApi } from '../../../_lib/demo-api';

export const dynamic = 'force-dynamic';

const MAX_SEQ = 1_000_000;

export async function GET(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  const raw = Number(new URL(request.url).searchParams.get('afterSeq') ?? '0');
  const afterSeq = Number.isInteger(raw) && raw >= 0 && raw <= MAX_SEQ ? raw : 0;
  try {
    const body = await demoApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=${afterSeq}`);
    return Response.json(body, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof DemoApiError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: 'demo_error' }, { status: 500 });
  }
}
