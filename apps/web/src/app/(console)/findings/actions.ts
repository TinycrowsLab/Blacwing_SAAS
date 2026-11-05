'use server';

// Gate 3 (experience spec §6.3): release or dismiss a finding with a reason, as the signed-in administrator. Returns an
// ActionResult (no `?error=` redirects): the page keeps the reason and shows one fix. The API records one ledger event
// per call and delivers a release to the webhook.
import { type FindingDetail, findingDetailSchema } from '../../../components/console/results/model';
import { callApi, toResult, type ActionResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { REASON_MIN, reasonChars } from '../../../lib/normalize';

const HTTP_UNAUTHORIZED = 401;
const HTTP_UNPROCESSABLE = 422;
const REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function triageFindingAction(
  findingId: string,
  decision: 'release' | 'dismiss',
  reason: string,
): Promise<ActionResult<FindingDetail>> {
  const session = await getViewer();
  if (session === null)
    return { ok: false, code: 'unauthenticated', message: 'Your session ended. Sign in again.', status: HTTP_UNAUTHORIZED };
  const text = reason.trim();
  if (!UUID.test(findingId))
    return { ok: false, code: 'not_found', message: 'That finding does not exist.', status: HTTP_UNPROCESSABLE };
  if (reasonChars(text) < REASON_MIN || text.length > REASON_MAX)
    return {
      ok: false,
      code: 'invalid_reason',
      message: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters. It is kept on the ledger.`,
      status: HTTP_UNPROCESSABLE,
    };
  return toResult(async () =>
    findingDetailSchema.parse(
      await callApi(session, `/findings/${encodeURIComponent(findingId)}/triage`, {
        method: 'POST',
        body: { decision: decision === 'dismiss' ? 'dismiss' : 'release', reason: text },
      }),
    ),
  );
}
