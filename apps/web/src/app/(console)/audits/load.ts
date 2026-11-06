// Server-side reads the order and the plan share. A refused read (429 under load, a dropped connection) is tried once
// more before the page gives up, so one busy moment never costs the person their order or their plan.
import { ApiError, callApi } from '../../../lib/api';
import { type Workspace, workspaceSchema } from '../../../lib/schemas';

import type { Viewer } from '../../../lib/auth';

const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const RETRY_AFTER_MS = 250;
/** The preset the order suggests (the plan offers them all). */
const SUGGESTED_PRESET = 'standard';

/** Worth one more try: rate limited, a server error, or no answer at all. Never a 4xx refusal. */
const transient = (error: unknown): boolean =>
  !(error instanceof ApiError) || error.status === HTTP_TOO_MANY || error.status >= HTTP_SERVER_ERROR;

/** Runs `read`, and once more after a short wait when the first failure was transient. */
export async function retryOnce<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!transient(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    return read();
  }
}

export const loadWorkspace = (session: Viewer): Promise<Workspace | null> =>
  retryOnce(async () => workspaceSchema.parse(await callApi(session, '/workspace'))).catch(() => null);

/** The workspace's suggested limits (Standard, else its first preset); null when there are none to suggest. */
export function suggestedLimits(
  workspace: Workspace | null,
): { minutes: number; requests: number; costUsd: number } | null {
  const presets = workspace?.settings.presets ?? [];
  const p = presets.find((x) => x.key === SUGGESTED_PRESET) ?? presets[0];
  return p === undefined ? null : { minutes: p.minutes, requests: p.requests, costUsd: p.costUsd };
}
