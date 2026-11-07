// Server-only reads for the results, findings, ledger and settings pages. The API limits each workspace to a few
// requests a second (10/s, burst 20), and one render plus a refresh can come close: a 429 is retried after a short
// back-off instead of replacing the page with an error, and a page asks for each path once per render (React cache).
// Never import this from a client component (it carries the internal token through lib/api).
import { cache } from 'react';

import { ApiError, callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';

const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY = 429;
const RETRIES = 3;
/** The bucket refills a token every 100 ms; these waits (300, 600, 900 ms) leave room for a whole burst to drain. */
const BACKOFF_MS = 300;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs an API call, retrying it on 429 only. Any other failure is thrown as it came. */
export async function retryBusy<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== HTTP_TOO_MANY || attempt > RETRIES)
        throw error;
      await wait(BACKOFF_MS * attempt);
    }
  }
}

/** GET as the signed-in user, once per path per render. Throws ApiError (401 when signed out). */
export const readApi = cache(async (path: string): Promise<unknown> => {
  const session = await getViewer();
  if (session === null) throw new ApiError(HTTP_UNAUTHORIZED, 'unauthenticated', 'Sign in first.');
  return retryBusy(() => callApi(session, path));
});
