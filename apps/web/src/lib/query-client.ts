import {
  type Mutation,
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
} from '@tanstack/react-query';

import { type ApiError, CLIENT_ERROR_CODES, isApiError } from './api-error.js';
import { createApiErrorMetrics, type ApiErrorMetrics } from './api-metrics.js';

import type { InvalidatesMeta } from './query-keys.js';

const QUERY_STALE_TIME_MS = 30_000;
const QUERY_GC_TIME_MS = 300_000;
/** Retries of a failing GET (so up to three attempts). */
const QUERY_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** Window in which parallel 401s trigger a single re-auth. */
const REDIRECT_DEDUPE_MS = 2000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** UI reactions to API errors. The toast component arrives with CONSOLE-010; until then handlers are injected. */
export interface ApiErrorHandlers {
  /** 401: send the user to sign in again. Called once per burst of parallel 401s. */
  readonly onUnauthenticated: () => void;
  /** 403: surface "permission denied" (never retried). */
  readonly onForbidden: (error: ApiError) => void;
  /** 429: the client is rate limited for `retryAfterMs`. */
  readonly onRateLimited: (error: ApiError, retryAfterMs: number | undefined) => void;
  /** 412: the resource changed under the user; the client has already started a refetch. */
  readonly onConflict: (error: ApiError) => void;
  /** Everything else: show a toast with `error.title` and `error.traceId` (never raw server internals). */
  readonly onError: (error: ApiError) => void;
}

export interface QueryClientOptions {
  readonly handlers?: Partial<ApiErrorHandlers>;
  readonly metrics?: ApiErrorMetrics;
  /** Test seam for the 401 redirect; defaults to `location.assign('/login?returnTo=…')`. */
  readonly redirect?: (url: string) => void;
}

/** Queries/mutations that render their own error state set `meta: { suppressGlobalError: true }`. */
export interface QueryMeta extends InvalidatesMeta {
  readonly suppressGlobalError?: boolean;
}

/** Whether a failed GET is worth another attempt: transport failures, 5xx and (after waiting) 429 only. */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return (
    error.code === CLIENT_ERROR_CODES.network ||
    error.status === HTTP_TOO_MANY_REQUESTS ||
    error.status >= HTTP_SERVER_ERROR
  );
}

/** Exponential backoff (1s, 2s, 4s … capped); a 429's `Retry-After` wins when present. */
export function retryDelay(attempt: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterMs !== undefined) return error.retryAfterMs;
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** Same-origin path to return to after sign-in; anything else collapses to `/` (no open redirect). */
function returnTo(): string {
  const { pathname, search } = globalThis.location;
  const target = `${pathname}${search}`;
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

/**
 * The console's `QueryClient` (CONSOLE-005): 30s stale, 5m gc, no refetch on focus, GETs retried twice with
 * backoff but never on 4xx, mutations never retried. Error mapping is centralised in the cache callbacks.
 */
export function makeQueryClient(options: QueryClientOptions = {}): QueryClient {
  const metrics = options.metrics ?? createApiErrorMetrics();
  const redirect =
    options.redirect ??
    ((url: string) => {
      globalThis.location.assign(url);
    });
  const handlers = options.handlers ?? {};
  let redirecting = false;

  const handle = (error: unknown, meta: QueryMeta | undefined): void => {
    if (!isApiError(error)) return;
    metrics.record(error.code);
    if (error.status === HTTP_UNAUTHORIZED) {
      if (redirecting) return;
      redirecting = true;
      setTimeout(() => {
        redirecting = false;
      }, REDIRECT_DEDUPE_MS);
      (
        handlers.onUnauthenticated ??
        (() => {
          redirect(`/login?returnTo=${encodeURIComponent(returnTo())}`);
        })
      )();
      return;
    }
    if (meta?.suppressGlobalError === true) return;
    if (error.status === HTTP_FORBIDDEN) handlers.onForbidden?.(error);
    else if (error.status === HTTP_TOO_MANY_REQUESTS)
      handlers.onRateLimited?.(error, error.retryAfterMs);
    else if (error.status === HTTP_PRECONDITION_FAILED) {
      void client.invalidateQueries();
      handlers.onConflict?.(error);
    } else handlers.onError?.(error);
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error: Error, query: Query<unknown, unknown, unknown>) => {
        handle(error, query.meta);
      },
    }),
    mutationCache: new MutationCache({
      onError: (
        error: Error,
        _variables: unknown,
        _context: unknown,
        mutation: Mutation<unknown, unknown>,
      ) => {
        handle(error, mutation.meta);
      },
      onSuccess: (
        _data: unknown,
        _variables: unknown,
        _context: unknown,
        mutation: Mutation<unknown, unknown>,
      ) => {
        for (const key of (mutation.meta as QueryMeta | undefined)?.invalidates ?? []) {
          void client.invalidateQueries({ queryKey: key });
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        gcTime: QUERY_GC_TIME_MS,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => failureCount < QUERY_MAX_RETRIES && isRetryable(error),
        retryDelay,
      },
      mutations: { retry: false },
    },
  });
  return client;
}
