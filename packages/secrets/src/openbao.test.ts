import { describe, expect, it } from 'vitest';

import { createOpenBaoClient, openBaoConfigFromEnv } from './openbao.js';

const config = { addr: 'http://bao:8200/', roleId: 'role-xyz', secretId: 'secret-hunter2' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scripted(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fakeFetch = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });
const login = (ttl = 3600) => json(200, { auth: { client_token: 'tok-1', lease_duration: ttl } });

describe('openBaoConfigFromEnv', () => {
  it('defaults the address and strips a trailing slash', () => {
    expect(openBaoConfigFromEnv({ OPENBAO_ROLE_ID: 'r', OPENBAO_SECRET_ID: 's' }).addr).toBe(
      'http://openbao:8200',
    );
    const c = openBaoConfigFromEnv({
      OPENBAO_ADDR: 'https://bao.example/',
      OPENBAO_ROLE_ID: 'r',
      OPENBAO_SECRET_ID: 's',
      OPENBAO_NAMESPACE: 'admin',
    });
    expect(c).toMatchObject({ addr: 'https://bao.example', namespace: 'admin' });
  });

  it.each([{}, { OPENBAO_ROLE_ID: 'r' }, { OPENBAO_SECRET_ID: 's' }])(
    'fails closed on %j',
    (env) => {
      expect(() => openBaoConfigFromEnv(env)).toThrow(
        'OPENBAO_ROLE_ID and OPENBAO_SECRET_ID must be set',
      );
    },
  );
});

describe('createOpenBaoClient', () => {
  it('logs in once, reuses the token and sends the namespace', async () => {
    const { calls, fakeFetch } = scripted([
      login(),
      json(200, { data: { a: 1 } }),
      json(200, { data: { b: 2 } }),
    ]);
    const client = createOpenBaoClient({ ...config, namespace: 'ns1' }, { fetch: fakeFetch });
    expect(await client.request('GET', 'transit/keys/tenant-a')).toEqual({
      status: 200,
      data: { a: 1 },
    });
    await client.request('POST', 'transit/keys/tenant-a/rotate');
    expect(calls.map((c) => c.url)).toEqual([
      'http://bao:8200/v1/auth/approle/login',
      'http://bao:8200/v1/transit/keys/tenant-a',
      'http://bao:8200/v1/transit/keys/tenant-a/rotate',
    ]);
    expect(calls[0]?.body).toEqual({ role_id: 'role-xyz', secret_id: 'secret-hunter2' });
    expect(calls[1]?.headers['x-vault-token']).toBe('tok-1');
    expect(calls[1]?.headers['x-vault-namespace']).toBe('ns1');
  });

  it('re-authenticates before the token expires', async () => {
    let t = 0;
    const { calls, fakeFetch } = scripted([
      login(100),
      json(200, {}),
      json(200, {}),
      login(100),
      json(200, {}),
    ]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch, now: () => t });
    await client.request('GET', 'x');
    t = 79_000;
    await client.request('GET', 'x');
    expect(calls).toHaveLength(3);
    t = 81_000;
    await client.request('GET', 'x');
    expect(calls.filter((c) => c.url.endsWith('auth/approle/login'))).toHaveLength(2);
  });

  it('re-authenticates once on 403 and retries', async () => {
    const { calls, fakeFetch } = scripted([
      login(),
      json(403, { errors: ['permission denied'] }),
      login(),
      json(200, { data: { ok: true } }),
    ]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch });
    expect((await client.request('GET', 'x')).data).toEqual({ ok: true });
    expect(calls).toHaveLength(4);
  });

  it('maps a persistent 403 to FORBIDDEN (policy denial, e.g. export)', async () => {
    const { fakeFetch } = scripted([login(), json(403, {}), login(), json(403, {})]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch });
    await expect(
      client.request('GET', 'transit/export/encryption-key/tenant-a'),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('retries login with exponential backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    const { fakeFetch } = scripted([
      json(503, {}),
      new Error('ECONNRESET'),
      login(),
      json(200, { data: {} }),
    ]);
    const client = createOpenBaoClient(config, {
      fetch: fakeFetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await client.request('GET', 'x');
    expect(sleeps).toEqual([200, 400]);
  });

  it('fails closed with KEK_UNAVAILABLE when login keeps failing, without leaking credentials', async () => {
    const { fakeFetch } = scripted([json(503, {}), json(503, {}), json(503, {})]);
    const client = createOpenBaoClient(config, {
      fetch: fakeFetch,
      sleep: () => Promise.resolve(),
      loginAttempts: 3,
    });
    const error: unknown = await client.request('GET', 'x').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'KEK_UNAVAILABLE' });
    const { message, detail } = error as { message: string; detail?: string };
    expect(`${message} ${detail ?? ''}`).not.toMatch(/hunter2|role-xyz/);
  });

  it('does not retry refused credentials', async () => {
    const { calls, fakeFetch } = scripted([json(400, { errors: ['invalid secret id'] })]);
    const client = createOpenBaoClient(config, {
      fetch: fakeFetch,
      sleep: () => Promise.resolve(),
    });
    await expect(client.request('GET', 'x')).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
  });

  it('maps sealed (503), 5xx and network errors to KEK_UNAVAILABLE', async () => {
    for (const failure of [
      json(503, { errors: ['Vault is sealed'] }),
      json(500, {}),
      new Error('down'),
    ]) {
      const { fakeFetch } = scripted([login(), failure]);
      const client = createOpenBaoClient(config, { fetch: fakeFetch });
      await expect(client.request('GET', 'x')).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
    }
  });

  it('resolves 404 and maps other 4xx to INTERNAL', async () => {
    const { fakeFetch } = scripted([login(), json(404, {}), json(400, { errors: ['bad'] })]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch });
    expect(await client.request('GET', 'x')).toEqual({ status: 404, data: undefined });
    await expect(client.request('POST', 'x', {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('maps a disallowed (shredded) key version to KEK_DISABLED without echoing the body', async () => {
    const body = { errors: ['ciphertext or signature version is disallowed by policy (too old)'] };
    const { fakeFetch } = scripted([login(), json(400, body)]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch });
    const error = await client.request('POST', 'transit/decrypt/k', {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'KEK_DISABLED' });
    expect((error as Error).message).not.toMatch(/too old/);
  });

  it('shares one login between concurrent requests', async () => {
    const { calls, fakeFetch } = scripted([login(), json(200, {}), json(200, {})]);
    const client = createOpenBaoClient(config, { fetch: fakeFetch });
    await Promise.all([client.request('GET', 'a'), client.request('GET', 'b')]);
    expect(calls.filter((c) => c.url.endsWith('auth/approle/login'))).toHaveLength(1);
  });
});
