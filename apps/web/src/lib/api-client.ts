import { MAX_PAGE_LIMIT } from '@blackwing/contracts';

import { ApiError, apiErrorFromResponse, CLIENT_ERROR_CODES, toNetworkError } from './api-error.js';
import { uuidV7 } from './uuid7.js';

import type { z } from 'zod';

/** BFF-relative API base when `NEXT_PUBLIC_API_BASE_URL` is unset. */
const DEFAULT_API_BASE_URL = '/v1';
/** Per-request timeout; the request fails as `NETWORK` after this. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** ETags remembered for `If-Match`; the oldest is dropped beyond this. */
const MAX_ETAGS = 500;
/** Most issue paths named in a CONTRACT_MISMATCH detail. */
const MAX_REPORTED_PATHS = 10;
const HTTP_NO_CONTENT = 204;
const HTTP_PRECONDITION_FAILED = 412;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type QueryValue = string | number | boolean | null | undefined;

/** Tenant is derived from the session on the server (CONTEXT_PACK §8.6); the client must never send one. */
const TENANT_NAME = /^x?-?tenant(-?id)?$/i;

interface ApiRequestOptions {
  /** Query-string parameters; `undefined`/`null` are skipped and `limit` is capped at 200. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** Abort signal (TanStack Query passes one; it aborts on unmount). */
  readonly signal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the auto-generated `Idempotency-Key` of a create POST (reuse it when retrying one submit). */
  readonly idempotencyKey?: string;
  /** Overrides the `If-Match` taken from the cached ETag of the same path. */
  readonly ifMatch?: string;
}

export interface ApiClientOptions {
  /** Defaults to `NEXT_PUBLIC_API_BASE_URL` or `/v1`. */
  readonly baseUrl?: string;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Test seam for the generated idempotency keys. */
  readonly newIdempotencyKey?: () => string;
}

export interface ApiClient {
  /** GET, validating the JSON body against `schema`. */
  get: <S extends z.ZodType>(
    path: string,
    schema: S,
    options?: ApiRequestOptions,
  ) => Promise<z.output<S>>;
  /** Create POST: sends an `Idempotency-Key` (UUIDv7) unless one is given. Pass `null` as schema for no body back. */
  post: <S extends z.ZodType | null>(
    path: string,
    schema: S,
    body?: unknown,
    options?: ApiRequestOptions,
  ) => Promise<S extends z.ZodType ? z.output<S> : undefined>;
  /** Update: sends `If-Match` from the cached ETag of `path` (or `options.ifMatch`). */
  put: <S extends z.ZodType | null>(
    path: string,
    schema: S,
    body?: unknown,
    options?: ApiRequestOptions,
  ) => Promise<S extends z.ZodType ? z.output<S> : undefined>;
  patch: <S extends z.ZodType | null>(
    path: string,
    schema: S,
    body?: unknown,
    options?: ApiRequestOptions,
  ) => Promise<S extends z.ZodType ? z.output<S> : undefined>;
  delete: (path: string, options?: ApiRequestOptions) => Promise<void>;
}

function defaultBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

function buildUrl(baseUrl: string, path: string, query: ApiRequestOptions['query']): string {
  // Only same-origin API paths: a scheme, `//host` or backslash would send the session cookie elsewhere.
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('://')
  ) {
    throw new TypeError('API path must be a relative path starting with a single "/"');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (TENANT_NAME.test(key)) throw new TypeError('The client must not send a tenant parameter');
    if (key === 'limit') {
      const limit = Math.trunc(Number(value));
      params.set(
        key,
        String(Math.min(Math.max(Number.isFinite(limit) ? limit : 1, 1), MAX_PAGE_LIMIT)),
      );
    } else {
      params.set(key, String(value));
    }
  }
  const search = params.toString();
  return `${baseUrl.replace(/\/+$/, '')}${path}${search === '' ? '' : `?${search}`}`;
}

function mismatch(status: number, issuePaths: string): ApiError {
  return new ApiError({
    status,
    code: CLIENT_ERROR_CODES.contractMismatch,
    title: 'Unexpected response',
    detail: issuePaths === '' ? undefined : `Response did not match its contract at: ${issuePaths}`,
  });
}

/**
 * Typed REST client for the BFF (`/v1`, CONSOLE-005). Cookies carry the session (no token ever touches
 * JS), responses are validated with Zod and never coerced, and every failure is an `ApiError`.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? defaultBaseUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const newKey = options.newIdempotencyKey ?? uuidV7;
  const etags = new Map<string, string>();

  const remember = (path: string, etag: string | null): void => {
    etags.delete(path);
    if (etag === null) return;
    etags.set(path, etag);
    if (etags.size > MAX_ETAGS) {
      const oldest = etags.keys().next();
      if (!oldest.done) etags.delete(oldest.value);
    }
  };

  async function send(
    method: Method,
    path: string,
    schema: z.ZodType | null,
    body: unknown,
    request: ApiRequestOptions,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (TENANT_NAME.test(name)) throw new TypeError('The client must not send a tenant header');
      headers[name] = value;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method === 'POST') headers['Idempotency-Key'] = request.idempotencyKey ?? newKey();
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const ifMatch = request.ifMatch ?? etags.get(path);
      if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
    }

    const url = buildUrl(baseUrl, path, request.query);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (cause) {
      // An unmount/navigation abort is not an error to report; only a timeout or transport failure is.
      if (request.signal?.aborted) throw cause;
      throw toNetworkError(timeout.aborted);
    }

    if (!response.ok) {
      if (response.status === HTTP_PRECONDITION_FAILED) etags.delete(path);
      throw apiErrorFromResponse(response.status, text, response.headers.get('Retry-After'));
    }

    remember(
      path,
      method === 'GET' || method === 'PUT' || method === 'PATCH'
        ? response.headers.get('ETag')
        : null,
    );
    if (schema === null || response.status === HTTP_NO_CONTENT) {
      if (schema !== null) throw mismatch(response.status, '');
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw mismatch(response.status, '');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const paths = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      throw mismatch(response.status, paths.slice(0, MAX_REPORTED_PATHS).join(', '));
    }
    return parsed.data;
  }

  return {
    get: (path, schema, request = {}) => send('GET', path, schema, undefined, request),
    post: (path, schema, body, request = {}) => send('POST', path, schema, body, request),
    put: (path, schema, body, request = {}) => send('PUT', path, schema, body, request),
    patch: (path, schema, body, request = {}) => send('PATCH', path, schema, body, request),
    delete: async (path, request = {}) => {
      await send('DELETE', path, null, undefined, request);
    },
  } as ApiClient;
}
