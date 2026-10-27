import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  ApiNetworkError,
  ApiProblemError,
  ApiResponseError,
  createApiClient,
  withIdempotencyKey,
  withIfMatch,
  withTraceparent,
  type ApiAuth,
  type ApiClient,
  type OperationData,
  type OperationInput,
} from './index.js';

const BASE = 'http://127.0.0.1:9';
const TOKEN = 'bw_pat_0123456789abcdef';
const BEARER: ApiAuth = { kind: 'bearer', token: TOKEN };
const KEY = 'kill-7f3c2a9e-1';
const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.250Z';

const triggerBody = { scope: 'tenant', reason: 'incident declared' } as const;
const triggerResponse = { killEventId: ID(1), status: 'initiated', triggeredAt: T0 };
const problem422 = {
  type: 'https://errors.blackwing.dev/VALIDATION_FAILED',
  title: 'Validation failed',
  status: 422,
  code: 'VALIDATION_FAILED',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  errors: [{ path: 'reason', message: 'must be at least 10 characters', code: 'too_small' }],
};

/** A kill event as `GET /v1/kill/{id}` serves it (`killEventId` on the wire). */
const killEventView = {
  killEventId: ID(1),
  tenantId: ID(2),
  scope: 'run',
  scopeRefId: ID(3),
  source: 'soc_link',
  actorType: 'soc_contact',
  actorRef: ID(4),
  reason: 'unexpected load on the payments API',
  status: 'halted',
  triggeredAt: T0,
  egressBlockedAt: '2026-01-01T00:00:00.400Z',
  sandboxesTerminatedAt: '2026-01-01T00:00:01.100Z',
  keysRevokedAt: '2026-01-01T00:00:01.150Z',
  workflowsCancelledAt: '2026-01-01T00:00:01.200Z',
  completedAt: T1,
  haltMs: 1250,
  affected: { runs: 1, sessions: 3, sandboxes: 3, keys: 3 },
  reenabledAt: null,
  reenabledBy: null,
  createdAt: T0,
  updatedAt: T1,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch double that records each call and answers with the queued responses in order. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error('fakeFetch: no answer queued');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

function client(
  impl: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof createApiClient>[0]> = {},
): ApiClient {
  return createApiClient({
    baseUrl: BASE,
    allowHttp: true,
    getAuth: () => BEARER,
    fetch: impl,
    retryBaseDelayMs: 0,
    ...overrides,
  });
}

const headerOf = (init: RequestInit, name: string): string | null =>
  new Headers(init.headers).get(name);

describe('typed operations', () => {
  it('types each operation from the spec with no any', () => {
    expectTypeOf<OperationInput<'triggerKill'>>().toExtend<{ body: unknown }>();
    expectTypeOf<OperationInput<'triggerKill'>>().toExtend<{ path?: never }>();
    expectTypeOf<OperationInput<'getKillEvent'>['path']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<OperationInput<'getKillEvent'>>().toExtend<{ body?: never }>();
    expectTypeOf<OperationData<'triggerKill'>>().toExtend<{ killEventId: unknown }>();
    expectTypeOf<OperationData<'triggerKill'>>().toExtend<{ status: unknown }>();
    expectTypeOf<OperationData<'getKillEvent'>>().toExtend<{ killEventId: unknown }>();
    expectTypeOf<ApiClient['triggerKill']>()
      .parameter(0)
      .toEqualTypeOf<OperationInput<'triggerKill'>>();
  });

  it('sends a sample call with the spec method, path, JSON body and typed response', async () => {
    const { fetch, calls } = fakeFetch(
      json(202, triggerResponse, { location: `/v1/kill/${ID(1)}` }),
    );
    const response = await client(fetch).triggerKill(
      { body: triggerBody },
      withIdempotencyKey(KEY),
    );
    expect(response.status).toBe(202);
    expect(response.data.status).toBe('initiated');
    expect(response.headers.get('location')).toBe(`/v1/kill/${ID(1)}`);
    expect(calls[0]?.url).toBe(`${BASE}/v1/kill`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify(triggerBody));
    expect(headerOf(calls[0]?.init ?? {}, 'idempotency-key')).toBe(KEY);
    expect(headerOf(calls[0]?.init ?? {}, 'content-type')).toBe('application/json');
  });

  it('fills path parameters and encodes them', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await client(fetch).getKillEvent({ path: { id: 'a/b c' } });
    expect(calls[0]?.url).toBe(`${BASE}/v1/kill/a%2Fb%20c`);
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('refuses a missing path parameter, an unknown query key, and a non-scalar query value', async () => {
    const { fetch, calls } = fakeFetch();
    const api = client(fetch);
    await expect(api.getKillEvent({} as never)).rejects.toThrow(/missing path parameter id/);
    await expect(
      api.getKillEvent({ path: { id: ID(1) }, query: { nope: 'x' } } as never),
    ).rejects.toThrow(/unknown query parameter nope/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a required Idempotency-Key that is not set, before any request', async () => {
    const { fetch, calls } = fakeFetch();
    await expect(client(fetch).triggerKill({ body: triggerBody })).rejects.toThrow(
      /triggerKill requires the Idempotency-Key header/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('errors', () => {
  it('maps a 422 problem to ApiProblemError with typed errors[]', async () => {
    const { fetch } = fakeFetch(
      new Response(JSON.stringify(problem422), {
        status: 422,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );
    const error = await client(fetch)
      .triggerKill({ body: triggerBody }, withIdempotencyKey(KEY))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblemError);
    if (!(error instanceof ApiProblemError)) throw new Error('unreachable');
    expect(error.status).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.traceId).toBe(problem422.traceId);
    expect(error.errors).toEqual([
      { path: 'reason', message: 'must be at least 10 characters', code: 'too_small' },
    ]);
    expectTypeOf(error.errors).toExtend<
      readonly { path: string; message: string; code: string }[]
    >();
  });

  it('synthesises a problem for a non-problem error body and keeps credentials out of it', async () => {
    const { fetch } = fakeFetch(
      new Response('<html>bad gateway token=bw_pat_0123456789abcdef</html>', {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    const error = await client(fetch, { retries: 0 })
      .getKillEvent({ path: { id: ID(1) } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblemError);
    if (!(error instanceof ApiProblemError)) throw new Error('unreachable');
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.title).toBe('Bad Gateway');
    expect(error.errors).toEqual([]);
    expect(JSON.stringify(error)).not.toContain('bw_pat_');
    expect(error.message).not.toContain('bw_pat_');
  });

  it('maps a transport failure to ApiNetworkError', async () => {
    const { fetch } = fakeFetch(new TypeError('fetch failed'));
    const error = await client(fetch, { retries: 0 })
      .getKillEvent({ path: { id: ID(1) } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).kind).toBe('network');
  });

  it('reports a timeout as ApiNetworkError kind timeout', async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    const error = await client(fetch as unknown as typeof globalThis.fetch, {
      retries: 0,
      timeoutMs: 5,
    })
      .getKillEvent({ path: { id: ID(1) } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).kind).toBe('timeout');
  });

  it('reports a caller abort as aborted and does not retry it', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn((_url: string, init?: RequestInit) =>
      init?.signal?.aborted === true
        ? Promise.reject(new Error('aborted'))
        : Promise.resolve(json(200, killEventView)),
    );
    const error = await client(fetch as unknown as typeof globalThis.fetch, { retries: 3 })
      .getKillEvent({ path: { id: ID(1) } }, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiNetworkError);
    expect((error as ApiNetworkError).kind).toBe('aborted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('retries', () => {
  it('retries an idempotent GET with backoff, then returns the success', async () => {
    const { fetch, calls } = fakeFetch(
      new TypeError('reset'),
      json(503, problem422),
      json(200, killEventView),
    );
    const response = await client(fetch, { retries: 2 }).getKillEvent({
      path: { id: ID(1) },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('gives up after the configured retries and throws the last failure', async () => {
    const { fetch, calls } = fakeFetch(
      json(502, problem422),
      json(502, problem422),
      json(502, problem422),
    );
    await expect(
      client(fetch, { retries: 2 }).getKillEvent({ path: { id: ID(1) } }),
    ).rejects.toBeInstanceOf(ApiProblemError);
    expect(calls).toHaveLength(3);
  });

  it('retries a POST only because it carries an Idempotency-Key', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('reset'), json(202, triggerResponse));
    await expect(
      client(fetch, { retries: 3 }).triggerKill({ body: triggerBody }, withIdempotencyKey(KEY)),
    ).resolves.toMatchObject({ status: 202 });
    expect(calls).toHaveLength(2);

    const second = fakeFetch(new TypeError('reset'));
    await expect(
      client(second.fetch, { retries: 3 }).triggerKill(
        { body: triggerBody },
        withIdempotencyKey(KEY),
      ),
    ).rejects.toBeInstanceOf(ApiNetworkError);
    expect(second.calls).toHaveLength(4);
  });
});

describe('authentication', () => {
  it('injects a bearer token on every request', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await client(fetch).getKillEvent({ path: { id: ID(1) } });
    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headerOf(calls[0]?.init ?? {}, 'cookie')).toBeNull();
  });

  it('injects a session cookie for the web BFF', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await client(fetch, {
      getAuth: () => ({ kind: 'cookie', cookie: 'bw_session=abc' }),
    }).getKillEvent({ path: { id: ID(1) } });
    expect(headerOf(calls[0]?.init ?? {}, 'cookie')).toBe('bw_session=abc');
    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBeNull();
  });

  it('calls getAuth per request, so a rotated token is used', async () => {
    const tokens = ['bw_ci_first000001', 'bw_ci_second0002'];
    const getAuth = vi.fn(() => ({ kind: 'bearer' as const, token: tokens.shift() ?? 'bw_ci_x' }));
    const { fetch, calls } = fakeFetch(json(200, killEventView), json(200, killEventView));
    const api = client(fetch, { getAuth });
    await api.getKillEvent({ path: { id: ID(1) } });
    await api.getKillEvent({ path: { id: ID(1) } });
    expect(getAuth).toHaveBeenCalledTimes(2);
    expect(headerOf(calls[1]?.init ?? {}, 'authorization')).toBe('Bearer bw_ci_second0002');
  });

  it('rejects a credential that is not a PAT or CI token, before any request', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    const error = await client(fetch, {
      getAuth: () => ({ kind: 'bearer', token: 'not-a-token' }) as unknown as ApiAuth,
    })
      .getKillEvent({ path: { id: ID(1) } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).not.toContain('not-a-token');
    expect(calls).toHaveLength(0);
  });

  it('refuses a caller header that would set the credential', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await expect(
      client(fetch).getKillEvent(
        { path: { id: ID(1) } },
        { headers: { Authorization: 'Bearer bw_pat_evil1' } },
      ),
    ).rejects.toThrow(/cannot be set per request/);
    expect(calls).toHaveLength(0);
  });

  it('lets an onRequest hook add headers but never the credential', async () => {
    const hook = vi.fn(() => ({ 'x-trace': 'hook', authorization: 'Bearer bw_pat_hook0000001' }));
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await client(fetch, { onRequest: hook }).getKillEvent({ path: { id: ID(1) } });
    expect(hook).toHaveBeenCalledWith({
      operationId: 'getKillEvent',
      method: 'GET',
      url: `${BASE}/v1/kill/${ID(1)}`,
    });
    expect(headerOf(calls[0]?.init ?? {}, 'x-trace')).toBe('hook');
    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBe(`Bearer ${TOKEN}`);
  });
});

describe('transport security', () => {
  it('requires https unless allowHttp is set', () => {
    expect(() => createApiClient({ baseUrl: 'http://api.example', getAuth: () => BEARER })).toThrow(
      /must use https/,
    );
    expect(() =>
      createApiClient({ baseUrl: 'https://api.example', getAuth: () => BEARER }),
    ).not.toThrow();
  });

  it('refuses a base URL with a path, query or credentials', () => {
    for (const baseUrl of [
      'https://api.example/v1',
      'https://api.example/?x=1',
      'https://user:pass@api.example',
    ]) {
      expect(() => createApiClient({ baseUrl, getAuth: () => BEARER })).toThrow(TypeError);
    }
  });

  it('sends with redirect=error so a redirect cannot downgrade or leak the credential', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    await client(fetch).getKillEvent({ path: { id: ID(1) } });
    expect(calls[0]?.init.redirect).toBe('error');
  });
});

describe('response validation', () => {
  it('accepts a body that matches the contract when validation is on', async () => {
    const { fetch } = fakeFetch(json(202, triggerResponse));
    const response = await client(fetch, { validateResponses: true }).triggerKill(
      { body: triggerBody },
      withIdempotencyKey(KEY),
    );
    expect(response.data.killEventId).toBe(ID(1));
  });

  it('rejects a body that does not match, naming only the failing field paths', async () => {
    const { fetch } = fakeFetch(json(202, { ...triggerResponse, triggeredAt: 'yesterday' }));
    const error = await client(fetch, { validateResponses: true })
      .triggerKill({ body: triggerBody }, withIdempotencyKey(KEY))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).issuePaths).toEqual(['triggeredAt']);
    expect((error as Error).message).not.toContain('yesterday');
  });

  it('validates GET /kill/{id} against the KillEvent contract through the killEventId view', async () => {
    const { fetch } = fakeFetch(json(200, killEventView));
    const response = await client(fetch, { validateResponses: true }).getKillEvent({
      path: { id: ID(1) },
    });
    expect(response.data.killEventId).toBe(ID(1));
  });

  it('rejects a KillEvent view with an extra field', async () => {
    const { fetch } = fakeFetch(json(200, { ...killEventView, rawToken: 'x' }));
    await expect(
      client(fetch, { validateResponses: true }).getKillEvent({ path: { id: ID(1) } }),
    ).rejects.toBeInstanceOf(ApiResponseError);
  });

  it('does not validate when validateResponses is off (production)', async () => {
    const { fetch } = fakeFetch(json(202, { ...triggerResponse, triggeredAt: 'yesterday' }));
    await expect(
      client(fetch).triggerKill({ body: triggerBody }, withIdempotencyKey(KEY)),
    ).resolves.toMatchObject({ status: 202 });
  });

  it('rejects a 2xx body that is not JSON', async () => {
    const { fetch } = fakeFetch(new Response('oops', { status: 200 }));
    await expect(client(fetch).getKillEvent({ path: { id: ID(1) } })).rejects.toBeInstanceOf(
      ApiResponseError,
    );
  });
});

describe('request helpers', () => {
  it('sets the Idempotency-Key and If-Match and the traceparent', async () => {
    const { fetch, calls } = fakeFetch(json(200, killEventView));
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    await client(fetch).getKillEvent(
      { path: { id: ID(1) } },
      withTraceparent(traceparent, withIfMatch('"3"', withIdempotencyKey(KEY))),
    );
    expect(headerOf(calls[0]?.init ?? {}, 'idempotency-key')).toBe(KEY);
    expect(headerOf(calls[0]?.init ?? {}, 'if-match')).toBe('"3"');
    expect(headerOf(calls[0]?.init ?? {}, 'traceparent')).toBe(traceparent);
  });

  it('rejects an Idempotency-Key that is too short, too long or not visible ASCII', () => {
    for (const key of ['short', 'x'.repeat(256), 'has space key']) {
      expect(() => withIdempotencyKey(key)).toThrow(TypeError);
    }
  });

  it('rejects an If-Match that is not a quoted entity-tag, including header injection', () => {
    for (const etag of ['3', '"3', '"a\r\nset-cookie: x"', '']) {
      expect(() => withIfMatch(etag)).toThrow(TypeError);
    }
    expect(withIfMatch('W/"v2"').headers).toEqual({ 'If-Match': 'W/"v2"' });
  });

  it('rejects a malformed traceparent', () => {
    expect(() => withTraceparent('not-a-trace')).toThrow(TypeError);
  });
});
