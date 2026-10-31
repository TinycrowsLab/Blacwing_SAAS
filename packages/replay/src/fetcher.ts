import { Readable } from 'node:stream';

import { REPLAY_REQUEST_TIMEOUT_MS, type Fetcher } from './replay.js';

import type { ObservedHeader } from './oracle.js';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/**
 * The most body bytes an oracle reads from one response (1 MiB). A larger body is cut here, so the evaluators compare
 * a bounded, evidence-backed slice and never hold an unbounded response in memory.
 */
export const REPLAY_RESPONSE_BODY_MAX_BYTES = 1_048_576;

/**
 * The live lab fetcher. Redirects are an error, not followed: a redirect could leave the verified scope, and
 * the guard only checks the URL it was given (§8.2). Bodies are read as text up to the byte bound and the timeout is
 * bounded.
 */
export const httpFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(REPLAY_REQUEST_TIMEOUT_MS),
  });
  return {
    status: response.status,
    body: await readBoundedText(response, REPLAY_RESPONSE_BODY_MAX_BYTES),
    headers: observedHeaders(response.headers),
  };
};

/**
 * Reads at most `maxBytes` of the body as UTF-8. Leaving the loop destroys the stream, so the rest of an oversized
 * body is never buffered.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return '';
  const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const take = Math.min(chunk.byteLength, maxBytes - total);
    chunks.push(Buffer.from(chunk.subarray(0, take)));
    total += take;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
