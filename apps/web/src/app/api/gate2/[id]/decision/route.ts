// The browser's Gate 2 decision (the decision card, wherever it shows). The API enforces the deadline and the role.
// A 409 means someone (another tab, another person, the deadline) closed it first: when the request is indeed closed,
// the answer is the decided request with `alreadyDecided`, so the card shows the receipt instead of an error (§10.4).
// GET is the request as it stands now: the card checks it before it shows "Denied automatically", and the full page
// polls it, so a decision made elsewhere shows within seconds.
import { z } from 'zod';

import { isUuid } from '../../../../(console)/decisions/asked';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { getAsUser } from '../../../../../lib/post-route';
import { gate2DetailSchema } from '../../../../../lib/schemas';

export const dynamic = 'force-dynamic';

const MAX_REASON = 500;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const bodySchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    reason: z.string().trim().max(MAX_REASON).optional(),
  })
  .strict();
const closedSchema = z.object({ status: z.string() }).loose();

const noStore = { 'cache-control': 'no-store' };

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ code: 'not_found' }, { status: 404, headers: noStore });
  return getAsUser(`/gate2/${encodeURIComponent(id)}`, (body) => gate2DetailSchema.parse(body));
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const session = await getViewer();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ code: 'not_found' }, { status: 404, headers: noStore });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ code: 'invalid_body' }, { status: 400 });
  const path = `/gate2/${encodeURIComponent(id)}`;
  try {
    return Response.json(
      await callApi(session, `${path}/decision`, { method: 'POST', body: body.data }),
      {
        headers: noStore,
      },
    );
  } catch (error) {
    if (!(error instanceof ApiError))
      return Response.json(
        { code: 'request_failed' },
        { status: HTTP_BAD_GATEWAY, headers: noStore },
      );
    if (error.status === HTTP_CONFLICT) {
      const current = await callApi(session, path).catch(() => null);
      const closed = closedSchema.safeParse(current);
      if (closed.success && closed.data.status !== 'pending')
        return Response.json({ ...closed.data, alreadyDecided: true }, { headers: noStore });
    }
    return Response.json(
      { code: error.code, message: error.message },
      { status: error.status, headers: noStore },
    );
  }
}
