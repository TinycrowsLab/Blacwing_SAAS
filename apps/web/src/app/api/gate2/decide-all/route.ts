// The browser's "Allow all" / "Deny all" for Gate 2: the ids the person saw, one shared reason. The API decides each
// through the single-decision path and answers with one receipt per id (decided, already decided, expired).
import { z } from 'zod';

import { isUuid } from '../../../(console)/decisions/asked';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { refuseMutation } from '../../../../lib/post-route';

export const dynamic = 'force-dynamic';

const MAX_REASON = 500;
const MAX_IDS = 200;
const HTTP_BAD_GATEWAY = 502;
const bodySchema = z
  .object({
    ids: z.array(z.string().refine(isUuid)).min(1).max(MAX_IDS),
    decision: z.enum(['approve', 'deny']),
    reason: z.string().trim().max(MAX_REASON).optional(),
  })
  .strict();
const answerSchema = z
  .object({
    decision: z.enum(['approve', 'deny']),
    results: z.array(
      z.object({
        id: z.string(),
        result: z.enum(['decided', 'already_decided', 'expired', 'closed', 'not_found']),
      }),
    ),
    decided: z.number(),
    alreadyDecided: z.number(),
    expired: z.number(),
    closed: z.number(),
    notFound: z.number(),
  })
  .loose();

const noStore = { 'cache-control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  const refused = refuseMutation(request, { json: true });
  if (refused !== null) return refused;
  const session = await getViewer();
  if (session === null) return Response.json({ code: 'unauthenticated' }, { status: 401 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success || new Set(body.data.ids).size !== body.data.ids.length)
    return Response.json({ code: 'invalid_body' }, { status: 400, headers: noStore });
  try {
    const answer = answerSchema.parse(
      await callApi(session, '/gate2/decide-all', { method: 'POST', body: body.data }),
    );
    // The ledger reference stays server side; the browser needs the receipts.
    const { results, decided, alreadyDecided, expired, closed, notFound, decision } = answer;
    return Response.json(
      { decision, results, decided, alreadyDecided, expired, closed, notFound },
      { headers: noStore },
    );
  } catch (error) {
    if (!(error instanceof ApiError))
      return Response.json({ code: 'request_failed' }, { status: HTTP_BAD_GATEWAY, headers: noStore });
    return Response.json(
      { code: error.code, message: error.message },
      { status: error.status, headers: noStore },
    );
  }
}
