'use server';

// "Run this audit again" (experience spec §7, B5): the API copies the request, test accounts included, server-side,
// so no secret travels to the browser. The new request waits at the plan for approval. On success the action redirects
// to that plan, so the plan page comes back in the same response (one round trip, not an action and then a navigation).
import { redirect } from 'next/navigation';

import { callApi, toResult, type ActionResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { requestSchema } from '../../../lib/schemas';

const HTTP_UNAUTHORIZED = 401;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runAgainAction(requestId: string): Promise<ActionResult<{ id: string }>> {
  const session = await getViewer();
  if (session === null)
    return { ok: false, code: 'unauthenticated', message: 'Your session ended. Sign in again.', status: HTTP_UNAUTHORIZED };
  if (!UUID.test(requestId)) return { ok: false, code: 'not_found', message: 'That audit does not exist.', status: 404 };
  const result = await toResult(async () => {
    const created = requestSchema.parse(
      await callApi(session, `/requests/${encodeURIComponent(requestId)}/clone`, { method: 'POST' }),
    );
    return { id: created.id };
  });
  if (!result.ok) return result;
  // Outside toResult: redirect works by throwing, and must reach Next untouched.
  redirect(`/audits/${encodeURIComponent(result.data.id)}`);
}
