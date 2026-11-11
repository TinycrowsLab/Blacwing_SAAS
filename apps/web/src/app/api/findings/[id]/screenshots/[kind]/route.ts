// A proof screenshot (PNG) of a finding. Only a signed-in user of the tenant gets it: the API applies the same
// visibility as for the finding itself. The bytes come as base64 JSON from the API and leave here as an image.
import { z } from 'zod';

import { ApiError, callApi } from '../../../../../../lib/api';
import { getViewer } from '../../../../../../lib/auth';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const shotSchema = z.object({ base64: z.string().min(1) });

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string; readonly kind: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return new Response('Sign in first.', { status: HTTP_UNAUTHORIZED });
  const { id, kind } = await params;
  if (!UUID.test(id) || (kind !== 'probe' && kind !== 'control'))
    return new Response('No such screenshot.', { status: HTTP_NOT_FOUND });
  try {
    const shot = shotSchema.parse(await callApi(session, `/findings/${id}/screenshots/${kind}`));
    return new Response(Buffer.from(shot.base64, 'base64'), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; img-src 'self' data:",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return new Response(error.message, { status: error.status });
    return new Response('The screenshot could not be read.', { status: HTTP_SERVER_ERROR });
  }
}
