'use server';

// Names the workspace (first sign-in, /welcome). The API accepts it from an administrator only and records
// `workspace.named` on the ledger.
import { callApi, toResult, type ActionResult } from '../../lib/api';
import { getViewer } from '../../lib/auth';
import { workspaceSchema } from '../../lib/schemas';
import { tidyWorkspaceName, workspaceNameError } from '../../lib/workspace-name';

const HTTP_UNAUTHORIZED = 401;
const HTTP_UNPROCESSABLE = 422;

export async function nameWorkspaceAction(name: string): Promise<ActionResult<{ name: string }>> {
  const session = await getViewer();
  if (session === null)
    return {
      ok: false,
      code: 'unauthenticated',
      message: 'Your session ended. Sign in again.',
      status: HTTP_UNAUTHORIZED,
    };
  const invalid = workspaceNameError(name);
  if (invalid !== null)
    return { ok: false, code: 'invalid_name', message: invalid, status: HTTP_UNPROCESSABLE };
  const tidy = tidyWorkspaceName(name);
  return toResult(async () => {
    const workspace = workspaceSchema.parse(
      await callApi(session, '/workspace', { method: 'POST', body: { name: tidy } }),
    );
    return { name: workspace.name ?? tidy };
  });
}
