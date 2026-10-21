import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { pageSchema } from '@blackwing/contracts';

import { createApiClient } from './api-client.js';
import { ApiError, isApiError } from './api-error.js';

const runSchema = z.object({ id: z.string(), name: z.string() });

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(
    {
      type: `https://errors.blackwing.dev/${code}`,
      title: 'Problem title',
      status,
      code,
      traceId: 'trace-1',
      ...extra,
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function setup(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('no response queued');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const client = createApiClient({
    baseUrl: '/v1',
    fetch: fetchMock as unknown as typeof fetch,
    newIdempotencyKey: (() => {
      let n = 0;
      return () => `key-${++n}`;
    })(),
  });
  const call = (index: number) => {
    const [url, init] = fetchMock.mock.calls[index] ?? [];
    return { url, init, headers: new Headers(init?.headers) };
  };
  return { client, fetchMock, call };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) return error;
    throw error;
  }
  throw new Error('expected rejection');
}

describe('api-client GET', () => {
  it('validates the body against its contract and returns typed data', async () => {
    const { client, call } = setup(json({ id: 'run_1', name: 'scan' }));
    const run = await client.get('/runs/run_1', runSchema);
    expect(run).toEqual({ id: 'run_1', name: 'scan' });
    expect(call(0).url).toBe('/v1/runs/run_1');
    expect(call(0).init?.credentials).toBe('same-origin');
    expect(call(0).headers.get('Idempotency-Key')).toBeNull();
  });

  it('throws CONTRACT_MISMATCH instead of coercing, listing paths but not values', async () => {
    const { client } = setup(json({ id: 7, name: 'secret-value' }));
    const error = await failure(client.get('/runs/1', runSchema));
    expect(error.code).toBe('CONTRACT_MISMATCH');
    expect(error.detail).toContain('id');
    expect(JSON.stringify(error)).not.toContain('secret-value');
  });

  it('treats a non-JSON 2xx body as CONTRACT_MISMATCH', async () => {
    const { client } = setup(new Response('<html>', { status: 200 }));
    expect((await failure(client.get('/runs/1', runSchema))).code).toBe('CONTRACT_MISMATCH');
  });

  it('caps limit at 200, skips undefined and encodes the cursor', async () => {
    const { client, call } = setup(json({ items: [], nextCursor: null, hasMore: false }));
    await client.get('/runs', pageSchema(runSchema), {
      query: { limit: 5000, cursor: 'a b&c', status: undefined },
    });
    expect(call(0).url).toBe('/v1/runs?limit=200&cursor=a+b%26c');
  });

  it('raises a limit below 1 to 1', async () => {
    const { client, call } = setup(json({ items: [], nextCursor: null, hasMore: false }));
    await client.get('/runs', pageSchema(runSchema), { query: { limit: 0 } });
    expect(call(0).url).toBe('/v1/runs?limit=1');
  });
});

describe('api-client errors', () => {
  it('turns a problem+json 422 into a typed ApiError', async () => {
    const { client } = setup(
      problem(422, 'validation_failed', {
        detail: 'Bad input',
        errors: [{ path: 'name', message: 'required', code: 'required' }],
      }),
    );
    const error = await failure(client.post('/runs', runSchema, { name: '' }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_failed',
      traceId: 'trace-1',
      detail: 'Bad input',
      title: 'Problem title',
    });
    expect(error.fieldErrors).toEqual([{ path: 'name', message: 'required', code: 'required' }]);
  });

  it.each([401, 403, 404, 409, 412])('maps %i to its status and code', async (status) => {
    const { client } = setup(problem(status, 'some_code'));
    const error = await failure(client.get('/x', runSchema));
    expect(error.status).toBe(status);
    expect(error.code).toBe('some_code');
  });

  it('drops the detail of 5xx problems (no server internals)', async () => {
    const { client } = setup(problem(500, 'internal', { detail: 'stack trace at db.ts:12' }));
    const error = await failure(client.get('/x', runSchema));
    expect(error.status).toBe(500);
    expect(error.detail).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['HTML', '<html>oops</html>'],
    ['wrong shape', '{"message":"x"}'],
  ])('synthesises a generic problem for a %s error body', async (_name, body) => {
    const { client } = setup(new Response(body, { status: 502 }));
    const error = await failure(client.get('/x', runSchema));
    expect(error).toMatchObject({ status: 502, code: 'HTTP_ERROR', title: 'Server error' });
    expect(error.traceId).toBeUndefined();
    expect(error.detail).toBeUndefined();
  });

  it('reads Retry-After seconds from a 429, bounded', async () => {
    const { client } = setup(
      withHeader(problem(429, 'rate_limited'), '7'),
      withHeader(problem(429, 'rate_limited'), '99999'),
    );
    expect((await failure(client.get('/x', runSchema))).retryAfterMs).toBe(7000);
    expect((await failure(client.get('/x', runSchema))).retryAfterMs).toBe(60_000);
  });

  it('maps a transport failure to NETWORK', async () => {
    const { client } = setup(new TypeError('fetch failed'));
    const error = await failure(client.get('/x', runSchema));
    expect(error).toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('rethrows a caller abort untouched (unmount), not as NETWORK', async () => {
    const controller = new AbortController();
    const abort = new DOMException('aborted', 'AbortError');
    const { client } = setup(abort);
    controller.abort();
    await expect(client.get('/x', runSchema, { signal: controller.signal })).rejects.toBe(abort);
  });

  it('times out as NETWORK', async () => {
    const client = createApiClient({
      baseUrl: '/v1',
      timeoutMs: 5,
      fetch: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timeout', 'TimeoutError'));
          });
        })) as unknown as typeof fetch,
    });
    const error = await failure(client.get('/x', runSchema));
    expect(error).toMatchObject({ code: 'NETWORK', detail: 'The request timed out.' });
  });
});

function withHeader(response: Response, retryAfter: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Retry-After', retryAfter);
  return new Response(response.body, { status: response.status, headers });
}

describe('api-client mutations', () => {
  it('adds a unique Idempotency-Key to create POSTs', async () => {
    const { client, call } = setup(json({ id: 'a', name: 'a' }), json({ id: 'b', name: 'b' }));
    await client.post('/runs', runSchema, { name: 'a' });
    await client.post('/runs', runSchema, { name: 'b' });
    expect(call(0).headers.get('Idempotency-Key')).toBe('key-1');
    expect(call(1).headers.get('Idempotency-Key')).toBe('key-2');
    expect(call(0).init?.body).toBe('{"name":"a"}');
    expect(call(0).headers.get('Content-Type')).toBe('application/json');
  });

  it('keeps an explicit Idempotency-Key so a double submit dedupes server-side', async () => {
    const { client, call } = setup(json({ id: 'a', name: 'a' }), json({ id: 'a', name: 'a' }));
    await client.post('/runs', runSchema, {}, { idempotencyKey: 'form-1' });
    await client.post('/runs', runSchema, {}, { idempotencyKey: 'form-1' });
    expect(call(0).headers.get('Idempotency-Key')).toBe('form-1');
    expect(call(1).headers.get('Idempotency-Key')).toBe('form-1');
  });

  it('generates real UUIDv7 keys by default', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ id: 'a', name: 'a' })));
    const client = createApiClient({ baseUrl: '/v1', fetch: fetchMock as unknown as typeof fetch });
    await client.post('/runs', runSchema, {});
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sends If-Match from the ETag cached by a GET, and not on POST', async () => {
    const { client, call } = setup(
      json({ id: 'r', name: 'a' }, { headers: { ETag: '"v1"' } }),
      json({ id: 'r', name: 'b' }, { headers: { ETag: '"v2"' } }),
      json({ id: 'r', name: 'c' }),
    );
    await client.get('/runs/r', runSchema);
    await client.patch('/runs/r', runSchema, { name: 'b' });
    await client.patch('/runs/r', runSchema, { name: 'c' });
    expect(call(1).headers.get('If-Match')).toBe('"v1"');
    expect(call(2).headers.get('If-Match')).toBe('"v2"');
  });

  it('lets an explicit ifMatch win and sends none when unknown', async () => {
    const { client, call } = setup(json({ id: 'r', name: 'a' }), json({ id: 'r', name: 'a' }));
    await client.put('/runs/r', runSchema, {});
    await client.put('/runs/r', runSchema, {}, { ifMatch: '"x"' });
    expect(call(0).headers.get('If-Match')).toBeNull();
    expect(call(1).headers.get('If-Match')).toBe('"x"');
  });

  it('forgets a stale ETag after a 412', async () => {
    const { client, call } = setup(
      json({ id: 'r', name: 'a' }, { headers: { ETag: '"v1"' } }),
      problem(412, 'precondition_failed'),
      json({ id: 'r', name: 'a' }),
    );
    await client.get('/runs/r', runSchema);
    expect((await failure(client.patch('/runs/r', runSchema, {}))).status).toBe(412);
    await client.patch('/runs/r', runSchema, {});
    expect(call(2).headers.get('If-Match')).toBeNull();
  });

  it('delete resolves on 204 and sends If-Match', async () => {
    const { client, call } = setup(
      json({ id: 'r', name: 'a' }, { headers: { ETag: '"v1"' } }),
      new Response(null, { status: 204 }),
    );
    await client.get('/runs/r', runSchema);
    await expect(client.delete('/runs/r')).resolves.toBeUndefined();
    expect(call(1).headers.get('If-Match')).toBe('"v1"');
  });

  it('post with a null schema returns undefined', async () => {
    const { client } = setup(new Response(null, { status: 202 }));
    await expect(client.post('/runs/r/kill', null)).resolves.toBeUndefined();
  });

  it('a 204 where a body is contracted is a mismatch', async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    expect((await failure(client.post('/runs', runSchema, {}))).code).toBe('CONTRACT_MISMATCH');
  });
});

describe('api-client safety', () => {
  it.each(['//evil.example/x', 'https://evil.example/x', 'runs', '/a\\b'])(
    'rejects path %s',
    async (path) => {
      const { client, fetchMock } = setup();
      await expect(client.get(path, runSchema)).rejects.toThrow(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('never sends a tenant header or parameter', async () => {
    const { client, fetchMock } = setup();
    await expect(client.get('/x', runSchema, { headers: { 'X-Tenant-Id': 't' } })).rejects.toThrow(
      /tenant/,
    );
    await expect(client.get('/x', runSchema, { query: { tenantId: 't' } })).rejects.toThrow(
      /tenant/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no Authorization header (session is cookie based)', async () => {
    const { client, call } = setup(json({ id: 'a', name: 'a' }));
    await client.get('/x', runSchema);
    expect(call(0).headers.get('Authorization')).toBeNull();
  });
});
