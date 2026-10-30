import { REPLAY_REQUEST_TIMEOUT_MS, type Fetcher } from './replay.js';

import type { ObservedHeader } from './oracle.js';

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
  return {
    status: response.status,
    body: await response.text(),
    headers: observedHeaders(response.headers),
  };
};

/**
 * Every response header, lowercased. `Set-Cookie` is read with `getSetCookie` so each cookie stays its own entry,
 * because a combined value cannot be split back into cookies safely.
 */
function observedHeaders(headers: Headers): ObservedHeader[] {
  const observed: ObservedHeader[] = [];
  headers.forEach((value, name) => {
    if (name !== 'set-cookie') observed.push({ name, value });
  });
  for (const value of headers.getSetCookie()) observed.push({ name: 'set-cookie', value });
  return observed;
}
