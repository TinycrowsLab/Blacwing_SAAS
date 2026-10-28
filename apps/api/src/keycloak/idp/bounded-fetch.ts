import { AppError, ValidationError } from '@blackwing/errors';

import type { ReadableStreamDefaultReader, ReadableStreamReadResult } from 'node:stream/web';

/** The HTTP transport: the global `fetch` by default. Injected so tests never reach the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Reads a response body with a byte cap. The whole body is never buffered past the cap. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ValidationError('the fetched document is too large', {
        detail: `the document must be at most ${maxBytes} bytes`,
      });
    }
    chunks.push(next.value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/**
 * Fetches a document from a customer or Keycloak endpoint with a timeout, a byte cap and no redirects. An
 * unreachable endpoint or a 429/5xx answer is `EXTERNAL_BACKEND_UNAVAILABLE` (503, retryable). Any other non-2xx
 * answer, including a redirect, is a validation failure: the configured URL is wrong.
 */
export async function fetchBoundedText(options: {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly accept: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}): Promise<string> {
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: options.accept },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    throw new AppError(
      'EXTERNAL_BACKEND_UNAVAILABLE',
      'The identity provider endpoint is unreachable',
      {
        cause,
        detail: 'The identity provider could not be reached. Retry the configuration later.',
      },
    );
  }
  if (response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR) {
    throw new AppError(
      'EXTERNAL_BACKEND_UNAVAILABLE',
      `The identity provider answered ${response.status}`,
      {
        detail: 'The identity provider is unavailable. Retry the configuration later.',
      },
    );
  }
  if (response.status < HTTP_OK || response.status >= HTTP_MULTIPLE_CHOICES) {
    throw new ValidationError('The identity provider endpoint did not return a document', {
      detail: `the endpoint answered ${response.status}; redirects are not followed`,
    });
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new ValidationError('the fetched document is too large', {
      detail: `the document must be at most ${options.maxBytes} bytes`,
    });
  }
  return readBounded(response, options.maxBytes);
}

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];
const PRIVATE_IPV6 = [/^::1$/, /^fc/i, /^fd/i, /^fe[89ab]/i, /^::ffff:/i];

/**
 * A URL the API may fetch on a customer's behalf: https, no credentials, no fragment, and no literal loopback,
 * link-local, private or unique-local address (SSRF, CWE-918). DNS names are not resolved here, so a name that
 * later points at a private address is a known gap (see the issue's online-porting follow-up).
 */
export function requirePublicHttpsUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`${what} is not a valid URL`, {
      detail: `${what} must be an https URL`,
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literalPrivate =
    PRIVATE_IPV4.some((pattern) => pattern.test(host)) ||
    PRIVATE_IPV6.some((pattern) => pattern.test(host));
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    host === '' ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (host.includes(':') && literalPrivate) ||
    (/^[\d.]+$/.test(host) && literalPrivate)
  ) {
    throw new ValidationError(`${what} is not allowed`, {
      detail: `${what} must be a public https URL without credentials or a fragment`,
    });
  }
  return url;
}
