'use server';

// Gate 3 (experience spec §6.3): release or dismiss a finding with a reason, as the signed-in administrator. Returns an
// ActionResult (no `?error=` redirects): the page keeps the reason and shows one fix. The API records one ledger event
// per call and delivers a release to the webhook. A success revalidates the console, so the same response carries the
// page's new numbers (banner, report card, "Your decisions") and nothing on screen is stale after a decision.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { retryBusy } from '../../../components/console/results/load';
import { type FindingDetail, findingDetailSchema } from '../../../components/console/results/model';
import { callApi, toResult, type ActionResult } from '../../../lib/api';
import { getViewer, type Viewer } from '../../../lib/auth';
import { REASON_MIN, reasonChars } from '../../../lib/normalize';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const REASON_MAX = 500;
const BATCH_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Refusal = Extract<ActionResult<never>, { ok: false }>;

const SIGNED_OUT: Refusal = {
  ok: false,
  code: 'unauthenticated',
  message: 'Your session ended. Sign in again.',
  status: HTTP_UNAUTHORIZED,
};

function reasonRefusal(reason: string): Refusal | null {
  const text = reason.trim();
  if (reasonChars(text) < REASON_MIN || text.length > REASON_MAX)
    return {
      ok: false,
      code: 'invalid_reason',
      message: `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters. It is kept on the ledger.`,
      status: HTTP_UNPROCESSABLE,
    };
  return null;
}

/** A reason is one line on the ledger: runs of spaces and newlines fold to one space. */
const tidyReason = (reason: string): string => reason.trim().replace(/\s+/g, ' ');

// A 429 (the API's per-workspace rate limit) is retried after a short wait: a decision is never lost to a busy moment.
const triage = (
  session: Viewer,
  findingId: string,
  decision: 'release' | 'dismiss',
  reason: string,
) =>
  toResult(async () =>
    findingDetailSchema.parse(
      await retryBusy(() =>
        callApi(session, `/findings/${encodeURIComponent(findingId)}/triage`, {
          method: 'POST',
          body: {
            decision: decision === 'dismiss' ? 'dismiss' : 'release',
            reason: tidyReason(reason),
          },
        }),
      ),
    ),
  );

export async function triageFindingAction(
  findingId: string,
  decision: 'release' | 'dismiss',
  reason: string,
): Promise<ActionResult<FindingDetail>> {
  const session = await getViewer();
  if (session === null) return SIGNED_OUT;
  const refused = reasonRefusal(reason);
  if (refused !== null) return refused;
  if (!UUID.test(findingId))
    return {
      ok: false,
      code: 'not_found',
      message: 'That finding does not exist.',
      status: HTTP_UNPROCESSABLE,
    };
  const result = await triage(session, findingId, decision, reason);
  // 409: someone already decided; the refreshed page shows their decision.
  if (result.ok || result.status === HTTP_CONFLICT) revalidatePath('/', 'layout');
  return result;
}

const batchSchema = z.object({
  moved: z.number(),
  conflicts: z.number().default(0),
  failed: z.number().default(0),
});

/** The pages a Gate 3 batch changes: the findings list, Decisions and the run's results (not the whole console). */
function revalidateGate3(runId: string | null): void {
  revalidatePath('/findings');
  revalidatePath('/decisions');
  if (runId !== null) revalidatePath(`/runs/${runId}/results`);
}

/**
 * "Release all proven": one batch call (the API writes one ledger event per finding it moved), then one targeted
 * refresh. An API without the batch route (404) gets the old way: one triage call per finding, one after another.
 */
export async function releaseFindingsAction(
  findingIds: readonly string[],
  reason: string,
  runId: string | null = null,
): Promise<ActionResult<{ released: number; failed: number }>> {
  const session = await getViewer();
  if (session === null) return SIGNED_OUT;
  const refused = reasonRefusal(reason);
  if (refused !== null) return refused;
  const ids = [...new Set(findingIds)].filter((id) => UUID.test(id)).slice(0, BATCH_MAX);
  const run = runId !== null && UUID.test(runId) ? runId : null;
  if (ids.length === 0) return { ok: true, data: { released: 0, failed: 0 } };
  const batch = await toResult(async () =>
    batchSchema.parse(
      await retryBusy(() =>
        callApi(session, '/findings/triage', {
          method: 'POST',
          body: { decision: 'release', reason: tidyReason(reason), ids },
        }),
      ),
    ),
  );
  if (batch.ok) {
    revalidateGate3(run);
    // A conflict means someone already decided it: not a failure.
    return { ok: true, data: { released: batch.data.moved, failed: batch.data.failed } };
  }
  if (batch.status !== HTTP_NOT_FOUND) return batch;
  let released = 0;
  let failed = 0;
  for (const id of ids) {
    const r = await triage(session, id, 'release', reason);
    if (r.ok) released += 1;
    else if (r.status !== HTTP_CONFLICT) failed += 1;
  }
  revalidateGate3(run);
  return { ok: true, data: { released, failed } };
}

/**
 * "Retest now": the runner replays this proven finding's probe and control against the site as it is today. The API
 * refuses a probe that changes data (that needs Gate 2, so a new audit) and rechecks ownership first.
 */
export async function retestFindingAction(findingId: string): Promise<ActionResult<{ retestId: string }>> {
  const session = await getViewer();
  if (session === null) return SIGNED_OUT;
  if (!UUID.test(findingId))
    return { ok: false, code: 'not_found', message: 'That finding does not exist.', status: HTTP_UNPROCESSABLE };
  const result = await toResult(async () =>
    z
      .object({ retestId: z.string() })
      .parse(await callApi(session, `/findings/${encodeURIComponent(findingId)}/replay`, { method: 'POST' })),
  );
  if (result.ok || result.status === HTTP_CONFLICT) revalidatePath(`/findings/${findingId}`);
  return result;
}
