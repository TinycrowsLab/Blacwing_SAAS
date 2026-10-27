import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ApiError, isApiError } from './api-error.js';
import { createGraphQLClient, defineQuery, GRAPHQL_MAX_DEPTH } from './graphql-client.js';

const runsQuery = defineQuery<{ runs: { id: string; state: string }[] }, { limit: number }>(
  'query DashboardRuns($limit: Int!) { runs(limit: $limit) { id state } }',
);

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function setup(...responses: (Response | Error)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn<typeof fetch>(() => {
    const next = queue.shift();
    if (next === undefined) throw new Error('no response queued');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return {
    fetchMock,
    body: (index: number) => {
      const raw = fetchMock.mock.calls[index]?.[1]?.body;
      if (typeof raw !== 'string') throw new TypeError('expected a string request body');
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('defineQuery', () => {
  it('reads the operation name and accepts a named query', () => {
    expect(runsQuery.operationName).toBe('DashboardRuns');
  });

  it.each([
    ['a mutation', 'mutation CreateRun { createRun { id } }'],
    ['a subscription', 'subscription Runs { runs { id } }'],
    ['an anonymous query', '{ runs { id } }'],
    ['two operations', 'query A { runs { id } } query B { runs { id } }'],
  ])('rejects %s at runtime', (_label, text) => {
    expect(() => defineQuery(text as `query ${string}`)).toThrow(TypeError);
  });

  it('rejects a mutation document at the type level', () => {
    // @ts-expect-error mutations are not accepted by defineQuery (CONTEXT_PACK §9: mutations stay on REST)
    const rejected = () => defineQuery('mutation CreateRun { createRun { id } }');
    expect(rejected).toThrow(TypeError);
  });

  it('rejects a syntax error at definition time', () => {
    expect(() => defineQuery('query Broken { runs { ')).toThrow();
  });

  it('rejects a query nested beyond the console depth cap', () => {
    const deep = `${'a { '.repeat(GRAPHQL_MAX_DEPTH + 1)}id${' }'.repeat(GRAPHQL_MAX_DEPTH + 1)}`;
    expect(() => defineQuery(`query Deep { ${deep} }` as `query ${string}`)).toThrow(/nests/);
  });
});

describe('createGraphQLClient', () => {
  it('runs a typed query and returns typed data with no warnings', async () => {
    const { fetchMock } = setup(json({ data: { runs: [{ id: 'r1', state: 'RUNNING' }] } }));
    const client = createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock });

    const result = await client.request(runsQuery, { limit: 5 });

    expect(result.data.runs[0]?.state).toBe('RUNNING');
    expect(result.warnings).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/graphql');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('POST');
  });

  it('sends the full document and variables when persisted queries are off', async () => {
    const { fetchMock, body } = setup(json({ data: { runs: [] } }));
    await createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
      runsQuery,
      { limit: 1 },
    );
    expect(body(0)).toEqual({
      operationName: 'DashboardRuns',
      variables: { limit: 1 },
      query: runsQuery.text,
    });
  });

  it('sends only the persisted-query hash in persisted mode, never the document', async () => {
    const { fetchMock, body } = setup(json({ data: { runs: [] } }));
    await createGraphQLClient({ url: '/graphql', persisted: true, fetch: fetchMock }).request(
      runsQuery,
      { limit: 1 },
    );
    const sent = body(0);
    expect(sent).not.toHaveProperty('query');
    expect(sent).toEqual({
      operationName: 'DashboardRuns',
      variables: { limit: 1 },
      extensions: { persistedQuery: { version: 1, sha256Hash: sha256(runsQuery.text) } },
    });
  });

  it('retries once with the full document in dev when the persisted query is unknown', async () => {
    const { fetchMock, body } = setup(
      json({ errors: [{ message: 'unknown', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] }),
      json({ data: { runs: [] } }),
    );
    const client = createGraphQLClient({
      url: '/graphql',
      persisted: true,
      fallbackOnPersistedMiss: true,
      fetch: fetchMock,
    });
    await client.request(runsQuery, { limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body(1)).toHaveProperty('query', runsQuery.text);
  });

  it('surfaces the persisted-query miss in production instead of resending the document', async () => {
    const { fetchMock } = setup(
      json({ errors: [{ message: 'unknown', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } }] }),
    );
    const client = createGraphQLClient({
      url: '/graphql',
      persisted: true,
      fallbackOnPersistedMiss: false,
      fetch: fetchMock,
    });
    const error = await failure(client.request(runsQuery, { limit: 1 }));
    expect(error.code).toBe('PERSISTED_QUERY_NOT_FOUND');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a GraphQL error to an ApiError with code, traceId and operation name', async () => {
    const { fetchMock } = setup(
      json(
        {
          data: null,
          errors: [
            { message: 'boom', extensions: { code: 'FORBIDDEN_FIELD', traceId: 'trace-9' } },
          ],
        },
        { status: 200 },
      ),
    );
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('FORBIDDEN_FIELD');
    expect(error.traceId).toBe('trace-9');
    expect(error.operation).toBe('DashboardRuns');
    expect(error.message).not.toContain('boom');
  });

  it('replaces an unsafe server code so arbitrary text never becomes ApiError.code', async () => {
    const { fetchMock } = setup(
      json({ errors: [{ message: 'x', extensions: { code: '<script>alert(1)</script>' } }] }),
    );
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error.code).toBe('GRAPHQL_ERROR');
  });

  it('turns a complexity or depth rejection into a friendly narrowing error', async () => {
    for (const code of ['COMPLEXITY_LIMIT', 'DEPTH_LIMIT']) {
      const { fetchMock } = setup(json({ errors: [{ message: 'too big', extensions: { code } }] }));
      const error = await failure(
        createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
          runsQuery,
          { limit: 1 },
        ),
      );
      expect(error.code).toBe('COMPLEXITY_LIMIT');
      expect(error.status).toBe(400);
      expect(error.detail).toMatch(/Narrow the filters/);
    }
  });

  it('returns data with a non-blocking warning when a non-critical field failed', async () => {
    const { fetchMock } = setup(
      json({
        data: { runs: [{ id: 'r1', state: 'DONE' }] },
        errors: [{ message: 'slow', extensions: { code: 'RESOLVER_TIMEOUT' } }],
      }),
    );
    const result = await createGraphQLClient({
      url: '/graphql',
      persisted: false,
      fetch: fetchMock,
    }).request(runsQuery, {
      limit: 1,
    });
    expect(result.data.runs).toHaveLength(1);
    expect(result.warnings).toEqual([{ code: 'RESOLVER_TIMEOUT' }]);
  });

  it('treats a response with errors and no data as an error', async () => {
    const { fetchMock } = setup(json({ data: null, errors: [{ message: 'x' }] }));
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error.code).toBe('GRAPHQL_ERROR');
  });

  it('rejects a 200 response that is not a GraphQL envelope as a contract mismatch', async () => {
    const { fetchMock } = setup(new Response('<html>proxy</html>', { status: 200 }));
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error.code).toBe('CONTRACT_MISMATCH');
  });

  it('maps an HTTP failure without a GraphQL body through the REST error model', async () => {
    const { fetchMock } = setup(
      new Response('nope', { status: 503, headers: { 'Retry-After': '4' } }),
    );
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error.status).toBe(503);
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.operation).toBe('DashboardRuns');
  });

  it('maps a transport failure to the NETWORK error', async () => {
    const { fetchMock } = setup(new TypeError('fetch failed'));
    const error = await failure(
      createGraphQLClient({ url: '/graphql', persisted: false, fetch: fetchMock }).request(
        runsQuery,
        { limit: 1 },
      ),
    );
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
  });

  it('rethrows an abort from the caller without reporting a network error', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const client = createGraphQLClient({
      url: '/graphql',
      persisted: false,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.request(runsQuery, { limit: 1 }, { signal: controller.signal }),
    ).rejects.toThrow('aborted');
  });

  it.each(['https://evil.test/graphql', '//evil.test/graphql', 'graphql', '/\\evil.test'])(
    'refuses a non-same-origin endpoint %s so the session cookie never leaves the origin',
    (url) => {
      expect(() => createGraphQLClient({ url })).toThrow(TypeError);
    },
  );
});
