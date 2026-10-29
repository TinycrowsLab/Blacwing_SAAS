import { REPLAY_REQUEST_TIMEOUT_MS, type Fetcher } from './replay.js';

/**
 * The live lab fetcher. Redirects are an error, not followed: a redirect could leave the verified scope, and
 * the guard only checks the URL it was given (§8.2). Bodies are read as text and the timeout is bounded.
 */
export const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(REPLAY_REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
};
