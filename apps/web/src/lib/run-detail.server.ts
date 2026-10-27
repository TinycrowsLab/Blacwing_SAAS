import { cookies } from 'next/headers';

import { PUBLIC_RUN_ID, runDetailSchema, type RunDetail } from './run-detail';
import { SESSION_COOKIE } from './session';

const DEFAULT_BFF_ORIGIN = 'http://127.0.0.1:3000';
const FETCH_TIMEOUT_MS = 5000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

export interface RunLoadDeps {
  readonly readCookie: () => Promise<string | undefined>;
  readonly fetch: typeof fetch;
  readonly bffOrigin: string;
}

/**
 * Loads a run on the server. Fails closed: an invalid id, a missing run, another tenant's run (the API
 * answers 404) and 401/403 all give `null`, which the page renders as 404 (CONTEXT_PACK §8.6). An outage
 * or a body that breaks the contract throws so the error boundary shows, never stale or partial data.
 */
export async function loadRun(runId: string, deps: RunLoadDeps): Promise<RunDetail | null> {
  if (!PUBLIC_RUN_ID.test(runId)) return null;
  const cookie = await deps.readCookie();
  if (cookie === undefined || cookie === '') return null;
  const response = await deps.fetch(new URL(`/v1/runs/${runId}`, deps.bffOrigin), {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}`, accept: 'application/json' },
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if ([HTTP_NOT_FOUND, HTTP_FORBIDDEN, HTTP_UNAUTHORIZED].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Run lookup failed with status ${String(response.status)}`);
  return runDetailSchema.parse(await response.json());
}

/** Server Component entry point: forwards the session cookie; the tenant comes from that session. */
export async function getRun(runId: string): Promise<RunDetail | null> {
  const store = await cookies();
  const origin = process.env.BW_WEB_BFF_ORIGIN;
  return loadRun(runId, {
    readCookie: () => Promise.resolve(store.get(SESSION_COOKIE)?.value),
    fetch,
    bffOrigin: origin === undefined || origin === '' ? DEFAULT_BFF_ORIGIN : origin,
  });
}
