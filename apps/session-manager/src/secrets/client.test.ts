import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { SECRET_RESOLVE_PATH } from '@blackwing/secrets';

import { createSecretsResolveClient, SecretFetchError, type SecretFetchRequest } from './client.js';

import type { AddressInfo } from 'node:net';

const BASE = 'http://secrets.internal:8080';
const TOKEN = 'bwsvc_eyJhbGciOiJIUzI1NiJ9.signature-token';
const TENANT = '0195c0de-0000-7000-8000-00000000000a';
const RUN = '0195c0de-0000-7000-8000-0000000000ff';
const REF = `bw-secret://${TENANT}/0195c0de-0000-7000-8000-0000000000b1`;
const SECRET_VALUE = 'the-plaintext-password-value';

const request: SecretFetchRequest = {
  tenantId: TENANT,
  secretRef: REF,
  callerPurpose: 'asset_login',
  runId: RUN,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (): Response => json(200, { value: SECRET_VALUE, version: 3, type: 'password' });

function clientWith(fetchImpl: typeof fetch, token: () => string | Promise<string> = () => TOKEN) {
  return createSecretsResolveClient({ baseUrl: BASE, serviceToken: token, fetch: fetchImpl });
}

describe('createSecretsResolveClient', () => {
  it('posts the reference to the internal resolve path with the service token and tenant', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    const result = await clientWith(fetchMock).fetch(request, {
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ value: SECRET_VALUE, version: 3, type: 'password' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect((url as URL).href).toBe(`${BASE}${SECRET_RESOLVE_PATH}`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['x-tenant-id']).toBe(TENANT);
    expect(JSON.parse(init?.body as string)).toEqual({
      secretRef: REF,
      callerPurpose: 'asset_login',
      runId: RUN,
    });
  });

  it('sends the context and trace id only when given', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(ok()));
    await clientWith(fetchMock).fetch(
      { ...request, context: { host: 'app.example.test' }, traceId: 'abc' },
      { signal: new AbortController().signal },
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toMatchObject({
      context: { host: 'app.example.test' },
    });
    expect((init?.headers as Record<string, string>)['x-bw-trace-id']).toBe('abc');
  });

  it('reads the service token for every call, so a rotated token is used', async () => {
    const tokens = ['bwsvc_first-token-value', 'bwsvc_second-token-value'];
    const seen: string[] = [];
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      seen.push((init?.headers as Record<string, string>).authorization ?? '');
      return Promise.resolve(ok());
    });
    const token = vi.fn(() => tokens.shift() ?? TOKEN);
    const client = clientWith(fetchMock, token);
    await client.fetch(request, { signal: new AbortController().signal });
    await client.fetch(request, { signal: new AbortController().signal });
    expect(seen).toEqual(['Bearer bwsvc_first-token-value', 'Bearer bwsvc_second-token-value']);
  });

  it('turns a refusal into a SecretFetchError carrying only the registered code', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json(404, {
          code: 'SECRET_NOT_FOUND',
          title: 'Secret not found',
          status: 404,
          retryable: false,
        }),
      ),
    );
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretFetchError);
    expect((error as SecretFetchError).code).toBe('SECRET_NOT_FOUND');
    expect(String(error)).not.toContain(SECRET_VALUE);
    expect(String(error)).not.toContain(TOKEN);
  });

  it('ignores an unregistered or malformed code in the body and falls back to the HTTP status', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(503, { code: `leaked ${SECRET_VALUE}` })),
    );
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('HTTP_503');
    expect(String(error)).not.toContain(SECRET_VALUE);
  });

  it('falls back to the HTTP status when an error body is not JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html>oops</html>', { status: 502 })),
    );
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('HTTP_502');
  });

  it('reports a transport failure as UNREACHABLE without echoing the cause', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error(`connect ECONNREFUSED ${TOKEN}`)),
    );
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('UNREACHABLE');
    expect(String(error)).not.toContain(TOKEN);
  });

  it.each([
    ['a missing value', { version: 1, type: 'password' }],
    ['an empty value', { value: '', version: 1, type: 'password' }],
    ['a zero version', { value: SECRET_VALUE, version: 0, type: 'password' }],
    ['a non-JSON body', 'not json'],
  ])('refuses a 200 response with %s', async (_label, body) => {
    const response =
      typeof body === 'string' ? new Response(body, { status: 200 }) : json(200, body);
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response));
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('MALFORMED_RESPONSE');
  });

  it('refuses an oversized success body', async () => {
    const huge = JSON.stringify({ value: 'x'.repeat(70 * 1024), version: 1, type: 'password' });
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(huge, { status: 200 })),
    );
    const error = await clientWith(fetchMock)
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('RESPONSE_TOO_LARGE');
  });

  it('aborts the request through the given signal', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted === true) reject(new Error('aborted'));
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const controller = new AbortController();
    const pending = clientWith(fetchMock).fetch(request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'UNREACHABLE' });
  });
});

describe('createSecretsResolveClient over a real TCP listener', () => {
  it('posts to the internal resolve path on the wire and returns the value', async () => {
    const seen: {
      url?: string | undefined;
      auth?: string | undefined;
      tenant?: string | undefined;
      body?: unknown;
    } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.tenant = req.headers['x-tenant-id'] as string | undefined;
        seen.body = JSON.parse(raw) as unknown;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ value: SECRET_VALUE, version: 7, type: 'password' }));
      });
    });
    const base = await listen(server);
    try {
      const fetched = await createSecretsResolveClient({
        baseUrl: base,
        serviceToken: () => TOKEN,
      }).fetch(request, { signal: new AbortController().signal });
      expect(fetched).toEqual({ value: SECRET_VALUE, version: 7, type: 'password' });
      expect(seen.url).toBe(SECRET_RESOLVE_PATH);
      expect(seen.auth).toBe(`Bearer ${TOKEN}`);
      expect(seen.tenant).toBe(TENANT);
      expect(seen.body).toEqual({ secretRef: REF, callerPurpose: 'asset_login', runId: RUN });
    } finally {
      server.close();
    }
  });

  it('turns a listener refusal into the registered code, with no body echoed', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'TENANT_MISMATCH' }));
    });
    const base = await listen(server);
    try {
      const error = await createSecretsResolveClient({ baseUrl: base, serviceToken: () => TOKEN })
        .fetch(request, { signal: new AbortController().signal })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretFetchError);
      expect((error as SecretFetchError).code).toBe('TENANT_MISMATCH');
      expect(String(error)).not.toContain(SECRET_VALUE);
    } finally {
      server.close();
    }
  });

  it('fails closed as UNREACHABLE when nothing listens (OpenBao or the Secrets Service down)', async () => {
    const server = createServer();
    const base = await listen(server);
    server.close();
    await once(server, 'close');
    const error = await createSecretsResolveClient({ baseUrl: base, serviceToken: () => TOKEN })
      .fetch(request, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((error as SecretFetchError).code).toBe('UNREACHABLE');
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}
