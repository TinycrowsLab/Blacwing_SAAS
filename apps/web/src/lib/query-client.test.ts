import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api-error.js';
import { createApiErrorMetrics } from './api-metrics.js';
import { isRetryable, makeQueryClient, retryDelay, type ApiErrorHandlers } from './query-client.js';
import { qk } from './query-keys.js';

import type { QueryClient } from '@tanstack/react-query';

const err = (status: number, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({ status, code: `c${status}`, title: 't', traceId: 'tr', ...extra });

function handlers(): { [K in keyof ApiErrorHandlers]: ReturnType<typeof vi.fn> } {
  return {
    onUnauthenticated: vi.fn(),
    onForbidden: vi.fn(),
    onRateLimited: vi.fn(),
    onConflict: vi.fn(),
    onError: vi.fn(),
  };
}

async function failQuery(
  client: QueryClient,
  error: unknown,
  meta?: Record<string, unknown>,
): Promise<void> {
  await client
    .query({
      queryKey: ['q', Math.random()],
      queryFn: () => Promise.reject(error as Error),
      retry: false,
      ...(meta ? { meta } : {}),
    })
    .catch(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('makeQueryClient defaults', () => {
  it('uses the specified cache and refetch defaults', () => {
    const { queries, mutations } = makeQueryClient().getDefaultOptions();
    expect(queries).toMatchObject({
      staleTime: 30_000,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
    });
    expect(mutations?.retry).toBe(false);
  });

  it('retries a GET at most twice and never on 4xx', () => {
    const retry = makeQueryClient().getDefaultOptions().queries?.retry as (
      n: number,
      e: unknown,
    ) => boolean;
    expect(retry(0, err(500))).toBe(true);
    expect(retry(1, err(500))).toBe(true);
    expect(retry(2, err(500))).toBe(false);
    for (const status of [400, 401, 403, 404, 409, 412, 422])
      expect(retry(0, err(status))).toBe(false);
    expect(retry(0, new ApiError({ status: 0, code: 'NETWORK', title: 'n' }))).toBe(true);
    expect(retry(0, new ApiError({ status: 200, code: 'CONTRACT_MISMATCH', title: 'x' }))).toBe(
      false,
    );
    expect(retry(0, new Error('boom'))).toBe(false);
  });

  it('really stops after three attempts on a 500 and one on a 404', async () => {
    const client = makeQueryClient();
    client.setDefaultOptions({
      ...client.getDefaultOptions(),
      queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
    });
    const flaky = vi.fn(() => Promise.reject(err(500)));
    await client.query({ queryKey: ['a'], queryFn: flaky }).catch(() => undefined);
    expect(flaky).toHaveBeenCalledTimes(3);
    const missing = vi.fn(() => Promise.reject(err(404)));
    await client.query({ queryKey: ['b'], queryFn: missing }).catch(() => undefined);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially and waits Retry-After on a 429', () => {
    expect(retryDelay(0, err(500))).toBe(1000);
    expect(retryDelay(1, err(500))).toBe(2000);
    expect(retryDelay(20, err(500))).toBe(30_000);
    expect(retryDelay(0, err(429, { retryAfterMs: 7000 }))).toBe(7000);
    expect(isRetryable(err(429))).toBe(true);
  });

  it('really waits Retry-After before retrying a 429', async () => {
    vi.useFakeTimers();
    const client = makeQueryClient();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err(429, { retryAfterMs: 5000 }))
      .mockResolvedValueOnce('ok');
    const result = client.query({ queryKey: ['r'], queryFn: fn });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('global error handling', () => {
  it('401 triggers re-auth once per burst', async () => {
    const h = handlers();
    const client = makeQueryClient({ handlers: h });
    await Promise.all([failQuery(client, err(401)), failQuery(client, err(401))]);
    expect(h.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('401 redirects to sign-in with a same-origin returnTo by default', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('location', { pathname: '/runs', search: '?a=1' });
    const client = makeQueryClient({ redirect });
    await failQuery(client, err(401));
    expect(redirect).toHaveBeenCalledWith('/login?returnTo=%2Fruns%3Fa%3D1');
    vi.unstubAllGlobals();
  });

  it('collapses a protocol-relative returnTo to /', async () => {
    const redirect = vi.fn();
    vi.stubGlobal('location', { pathname: '//evil.example', search: '' });
    await failQuery(makeQueryClient({ redirect }), err(401));
    expect(redirect).toHaveBeenCalledWith('/login?returnTo=%2F');
    vi.unstubAllGlobals();
  });

  it('allows a second re-auth after the dedupe window', async () => {
    vi.useFakeTimers();
    const h = handlers();
    const client = makeQueryClient({ handlers: h });
    await failQuery(client, err(401));
    await vi.advanceTimersByTimeAsync(2001);
    await failQuery(client, err(401));
    expect(h.onUnauthenticated).toHaveBeenCalledTimes(2);
  });

  it('403 surfaces permission-denied only', async () => {
    const h = handlers();
    await failQuery(makeQueryClient({ handlers: h }), err(403));
    expect(h.onForbidden).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onUnauthenticated).not.toHaveBeenCalled();
  });

  it('429 reports Retry-After to the rate-limit handler', async () => {
    const h = handlers();
    await failQuery(makeQueryClient({ handlers: h }), err(429, { retryAfterMs: 3000 }));
    expect(h.onRateLimited).toHaveBeenCalledWith(expect.any(ApiError), 3000);
  });

  it('other errors go to the toast handler with their traceId', async () => {
    const h = handlers();
    await failQuery(makeQueryClient({ handlers: h }), err(500));
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect((h.onError.mock.calls[0]?.[0] as ApiError).traceId).toBe('tr');
  });

  it('suppressGlobalError skips the toast but still re-auths on 401', async () => {
    const h = handlers();
    const client = makeQueryClient({ handlers: h });
    await failQuery(client, err(404), { suppressGlobalError: true });
    expect(h.onError).not.toHaveBeenCalled();
    await failQuery(client, err(401), { suppressGlobalError: true });
    expect(h.onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('ignores non-ApiError failures and missing handlers', async () => {
    const h = handlers();
    const metrics = createApiErrorMetrics();
    const client = makeQueryClient({ handlers: h, metrics });
    await failQuery(client, new Error('boom'));
    await failQuery(makeQueryClient(), err(500));
    expect(h.onError).not.toHaveBeenCalled();
    expect(metrics.snapshot()).toEqual({});
  });

  it('counts api_error by code in memory', async () => {
    const metrics = createApiErrorMetrics();
    const client = makeQueryClient({ metrics, handlers: handlers() });
    await failQuery(client, err(500));
    await failQuery(client, err(500));
    await failQuery(client, err(403));
    expect(metrics.snapshot()).toEqual({ c500: 2, c403: 1 });
    metrics.reset();
    expect(metrics.snapshot()).toEqual({});
  });

  it('mutation errors use the same mapping', async () => {
    const h = handlers();
    const client = makeQueryClient({ handlers: h });
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(err(403)) })
      .execute(undefined)
      .catch(() => undefined);
    expect(h.onForbidden).toHaveBeenCalledTimes(1);
  });

  it('412 on a mutation shows the conflict and refetches active queries', async () => {
    const h = handlers();
    const client = makeQueryClient({ handlers: h });
    const queryFn = vi.fn(() => Promise.resolve(1));
    await client.query({ queryKey: qk.runs.detail('r1'), queryFn });
    const spy = vi.spyOn(client, 'invalidateQueries');
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(err(412)) })
      .execute(undefined)
      .catch(() => undefined);
    expect(h.onConflict).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });

  it('invalidates meta.invalidates keys after a successful mutation', async () => {
    const client = makeQueryClient();
    await client.query({
      queryKey: qk.runs.list({ status: 'x' }),
      queryFn: () => Promise.resolve(1),
    });
    await client.query({ queryKey: ['other'], queryFn: () => Promise.resolve(1) });
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.resolve(1), meta: { invalidates: [qk.runs.all] } })
      .execute(undefined);
    expect(client.getQueryState(qk.runs.list({ status: 'x' }))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['other'])?.isInvalidated).toBe(false);
  });
});
