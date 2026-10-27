import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createSecretResolveHandler, SECRET_RESOLVE_PATH } from './resolve-endpoint.js';
import { SECRET_PURPOSES } from './resolve.js';
import {
  KEY,
  PLAINTEXT,
  REF,
  RUN_ID,
  SECRET_ID,
  setup,
  TENANT_A,
  TENANT_B,
} from './resolve.test-helpers.js';
import { createServiceTokenVerifier, signServiceToken } from './service-auth.js';

import type { AddressInfo } from 'node:net';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const bearer = (service: Parameters<typeof signServiceToken>[1]['service'] = 'egress-gateway') =>
  `Bearer ${signServiceToken(KEY, { service, tokenId: 'tok-9', expiresAt: Math.floor(Date.now() / 1000) + 600 })}`;

async function start(
  opts: { allowedPeerCidrs?: string[]; setupOverrides?: Parameters<typeof setup>[0] } = {},
) {
  const metrics = { resolved: [] as string[], denied: [] as string[], latency: 0 };
  const sink = {
    resolved: (service: string, result: string) => metrics.resolved.push(`${service}:${result}`),
    denied: (reason: string) => metrics.denied.push(reason),
    latency: () => (metrics.latency += 1),
  };
  const fixture = await setup({ metrics: sink, ...opts.setupOverrides });
  const handler = createSecretResolveHandler({
    resolver: fixture.resolver,
    tokens: createServiceTokenVerifier({ key: KEY }),
    allowedPeerCidrs: opts.allowedPeerCidrs ?? ['127.0.0.0/8', '::1'],
    metrics: sink,
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    over: {
      auth?: string | null;
      tenant?: string | null;
      body?: unknown;
      method?: string;
      path?: string;
      trace?: string;
    } = {},
  ) =>
    fetch(`${base}${over.path ?? SECRET_RESOLVE_PATH}`, {
      method: over.method ?? 'POST',
      headers: {
        ...(over.auth === null ? {} : { authorization: over.auth ?? bearer() }),
        ...(over.tenant === null ? {} : { 'x-tenant-id': over.tenant ?? TENANT_A }),
        ...(over.trace === undefined ? {} : { 'x-bw-trace-id': over.trace }),
        'content-type': 'application/json',
      },
      ...(over.method === 'GET'
        ? {}
        : {
            body:
              typeof over.body === 'string'
                ? over.body
                : JSON.stringify(
                    over.body ?? {
                      secretRef: REF,
                      callerPurpose: SECRET_PURPOSES.assetLogin,
                      runId: RUN_ID,
                    },
                  ),
          }),
    });
  return { ...fixture, call, metrics };
}

describe('POST /internal/secrets/resolve', () => {
  it('resolves for an authenticated service, audits, and sends no-store', async () => {
    const { call, audited, metrics } = await start();
    const res = await call({ trace: 'b'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ value: PLAINTEXT, version: 1, type: 'password' });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      action: 'secret.resolved',
      outcome: 'success',
      traceId: 'b'.repeat(32),
      actor: { type: 'service', id: 'egress-gateway', tokenId: 'tok-9' },
    });
    expect(metrics.resolved).toEqual(['egress-gateway:ok']);
  });

  it.each([
    ['no token', { auth: null }],
    ['a user token', { auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' }],
    ['a run token', { auth: 'Bearer bwrun_abc.def' }],
    [
      'a token for an unknown service',
      {
        auth: `Bearer ${signServiceToken(KEY, { service: 'egress-gateway', tokenId: 't', expiresAt: 1 })}`,
      },
    ],
  ])('rejects %s with SERVICE_AUTH_FAILED and does not audit or resolve', async (_name, over) => {
    const { call, audited, metrics, transit } = await start();
    const calls = transit.calls;
    const res = await call(over);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: 'SERVICE_AUTH_FAILED',
      title: 'Service authentication failed',
      status: 401,
      retryable: false,
    });
    expect(audited).toEqual([]);
    expect(transit.calls).toBe(calls);
    expect(metrics.denied).toEqual(['SERVICE_AUTH_FAILED']);
    expect(metrics.resolved).toEqual(['unknown:denied']);
  });

  it('denies a purpose outside the service matrix and audits the denial', async () => {
    const { call, audited } = await start();
    const res = await call({
      auth: bearer('model-gateway'),
      body: { secretRef: REF, callerPurpose: 'asset_login', runId: RUN_ID },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'SECRET_PURPOSE_DENIED' });
    expect(audited[0]).toMatchObject({ outcome: 'denied', actor: { id: 'model-gateway' } });
  });

  it('denies a cross-tenant reference with TENANT_MISMATCH', async () => {
    const { call } = await start();
    const res = await call({
      body: {
        secretRef: `bw-secret://${TENANT_B}/${SECRET_ID}`,
        callerPurpose: 'asset_login',
        runId: RUN_ID,
      },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'TENANT_MISMATCH' });
  });

  it('denies a killed run with RUN_KILLED (423)', async () => {
    const { call, runs } = await start();
    runs.standing = 'killed';
    const res = await call();
    expect(res.status).toBe(423);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'RUN_KILLED' });
  });

  it('fails closed with 503 KEK_UNAVAILABLE and never leaks internals', async () => {
    const { call, transit } = await start();
    transit.down = true;
    const res = await call();
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: 'KEK_UNAVAILABLE', retryable: true });
    expect(text).not.toContain('sealed');
    expect(text).not.toContain(PLAINTEXT);
  });

  it('answers 429 with Retry-After from the per-service rate limit', async () => {
    const { call } = await start({ setupOverrides: { rateLimit: { limit: 1, windowMs: 60_000 } } });
    expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses a missing or malformed tenant header', async () => {
    const { call } = await start();
    for (const tenant of [null, 'tenant-a', '0190000A-0000-7000-8000-000000000001']) {
      const res = await call({ tenant });
      expect(res.status).toBe(403);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'TENANT_CONTEXT_MISSING',
      });
    }
  });

  it.each([
    ['not json', '{nope'],
    ['an array', '[]'],
    [
      'an unknown field',
      JSON.stringify({ secretRef: REF, callerPurpose: 'asset_login', runId: RUN_ID, extra: 1 }),
    ],
    ['a missing purpose', JSON.stringify({ secretRef: REF })],
    ['a bad purpose', JSON.stringify({ secretRef: REF, callerPurpose: 'Asset Login' })],
    [
      'a bad run id',
      JSON.stringify({ secretRef: REF, callerPurpose: 'asset_login', runId: 'run-1' }),
    ],
    [
      'a non-string context value',
      JSON.stringify({ secretRef: REF, callerPurpose: 'asset_login', context: { a: 1 } }),
    ],
    [
      'an oversized body',
      JSON.stringify({
        secretRef: REF,
        callerPurpose: 'asset_login',
        context: { a: 'x'.repeat(40_000) },
      }),
    ],
  ])('rejects %s as VALIDATION_FAILED (422)', async (_name, body) => {
    const { call, audited } = await start();
    const res = await call({ body });
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(audited).toEqual([]);
  });

  it('answers 422 INVALID_SECRET_REF for a well-formed body with a bad reference', async () => {
    const { call } = await start();
    const res = await call({
      body: { secretRef: 'bw-secret://a/b/c', callerPurpose: 'asset_login', runId: RUN_ID },
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_SECRET_REF' });
  });

  it('serves only POST on its own path', async () => {
    const { call } = await start();
    expect((await call({ method: 'GET' })).status).toBe(405);
    expect((await call({ path: '/internal/secrets/resolve/extra' })).status).toBe(404);
    expect((await call({ path: '/internal/secrets' })).status).toBe(404);
    expect((await call({ path: '/v1/secrets/resolve' })).status).toBe(404);
  });

  describe('network source', () => {
    it('refuses a peer outside the allowlist, before authentication', async () => {
      const { call, audited, metrics, transit } = await start({
        allowedPeerCidrs: ['10.20.0.0/16'],
      });
      const calls = transit.calls;
      const res = await call();
      expect(res.status).toBe(403);
      expect(transit.calls).toBe(calls);
      expect(audited).toEqual([]);
      expect(metrics.denied).toEqual(['peer_not_allowed']);
    });

    it('refuses every request when the allowlist is empty', async () => {
      const { call } = await start({ allowedPeerCidrs: [] });
      expect((await call()).status).toBe(403);
    });

    it('ignores X-Forwarded-For', async () => {
      const { call } = await start({ allowedPeerCidrs: ['10.20.0.0/16'] });
      const res = await fetch(
        `http://127.0.0.1:${(server?.address() as AddressInfo).port}${SECRET_RESOLVE_PATH}`,
        {
          method: 'POST',
          headers: {
            authorization: bearer(),
            'x-tenant-id': TENANT_A,
            'x-forwarded-for': '10.20.1.1',
          },
          body: '{}',
        },
      );
      expect(res.status).toBe(403);
      expect(call).toBeDefined();
    });

    it('rejects a malformed allowlist at construction', async () => {
      const { resolver } = await setup();
      const tokens = createServiceTokenVerifier({ key: KEY });
      for (const bad of ['nope', '10.0.0.0/33', '10.0.0.0/8/8', '::/129', '10.0.0.0/x']) {
        expect(() =>
          createSecretResolveHandler({ resolver, tokens, allowedPeerCidrs: [bad] }),
        ).toThrowError(/invalid CIDR/);
      }
    });
  });
});
