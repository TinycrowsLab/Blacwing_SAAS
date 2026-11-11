'use server';

// "Run this audit again" (experience spec §7, B5): the API copies the request, test accounts included, server-side,
// so no secret travels to the browser. The new request waits at the plan for approval. The action returns the new
// plan's id and the button navigates on the client: a redirect here would render the whole plan page inside the action.
// With `untriedFromRunId` the copy also asks Blackwing to continue with the test cases that run left untried.
import { loadWorkspace } from '../../../app/(console)/audits/load';
import { callApi, toResult, type ActionResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { requestSchema, type Workspace } from '../../../lib/schemas';

const HTTP_UNAUTHORIZED = 401;
const SECONDS_PER_MINUTE = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runAgainAction(
  requestId: string,
  untriedFromRunId: string | null = null,
  limits: { readonly minutes: number; readonly requests: number; readonly costUsd: number } | null = null,
): Promise<ActionResult<{ id: string }>> {
  const session = await getViewer();
  if (session === null)
    return {
      ok: false,
      code: 'unauthenticated',
      message: 'Your session ended. Sign in again.',
      status: HTTP_UNAUTHORIZED,
    };
  if (!UUID.test(requestId) || (untriedFromRunId !== null && !UUID.test(untriedFromRunId)))
    return { ok: false, code: 'not_found', message: 'That audit does not exist.', status: 404 };
  return toResult(async () => {
    const created = requestSchema.parse(
      await callApi(session, `/requests/${encodeURIComponent(requestId)}/clone`, {
        method: 'POST',
        ...(untriedFromRunId === null && limits === null
          ? {}
          : {
              body: {
                ...(untriedFromRunId === null ? {} : { untriedFromRunId }),
                ...(limits === null
                  ? {}
                  : { limits: { budgetRequests: limits.requests, budgetSeconds: limits.minutes * SECONDS_PER_MINUTE, costCapUsd: limits.costUsd } }),
              },
            }),
      }),
    );
    return { id: created.id };
  });
}

/** The workspace's limit presets and ranges, for "Continue where it left off"; null when they did not load. */
export async function limitSettingsAction(): Promise<Workspace['settings'] | null> {
  const session = await getViewer();
  if (session === null) return null;
  return (await loadWorkspace(session))?.settings ?? null;
}
