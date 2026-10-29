import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ScopeViolationError, ValidationError } from '@blackwing/errors';

import { createLabEgress, createLocalSandboxProvider } from './adapters.js';
import { juiceShopScopeRules } from './juice-shop-sqli.js';

import type { Fetcher } from './replay.js';

const servers: Server[] = [];

/** Closes every listener this file opened. */
async function closeAll(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        ),
    ),
  );
}

afterEach(closeAll);

/** Starts a loopback TCP listener and returns its port. */
async function listen(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

const LAB = 'http://127.0.0.1:13000';
const scope = juiceShopScopeRules(new URL(LAB));

describe('createLabEgress', () => {
  it('sends an in-scope GET to the fetcher and returns its response', async () => {
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve({ status: 200, body: 'ok' }));
    const egress = createLabEgress({ scope, fetcher });

    await expect(
      egress.request({ method: 'GET', url: `${LAB}/rest/products/search?q=apple`, body: null }),
    ).resolves.toEqual({ status: 200, body: 'ok' });
    expect(fetcher).toHaveBeenCalledWith(`${LAB}/rest/products/search?q=apple`);
  });

  it('refuses a non-GET method before the fetcher is called', async () => {
    const fetcher = vi.fn<Fetcher>();
    const egress = createLabEgress({ scope, fetcher });

    await expect(
      egress.request({ method: 'POST', url: `${LAB}/rest/basket`, body: null }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a GET that carries a body', async () => {
    const fetcher = vi.fn<Fetcher>();
    const egress = createLabEgress({ scope, fetcher });

    await expect(
      egress.request({ method: 'GET', url: `${LAB}/`, body: '{"x":1}' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks an out-of-scope URL and an unverified host before any traffic', async () => {
    const fetcher = vi.fn<Fetcher>();
    const egress = createLabEgress({ scope, fetcher });

    await expect(
      egress.request({ method: 'GET', url: 'http://127.0.0.1:13999/', body: null }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(
      egress.request({ method: 'GET', url: 'http://example.com/', body: null }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks an excluded path of an in-scope host', async () => {
    const fetcher = vi.fn<Fetcher>();
    const egress = createLabEgress({ scope, fetcher });

    await expect(
      egress.request({
        method: 'GET',
        url: `${LAB}/rest/admin/application-version`,
        body: null,
      }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('probes an open in-scope port and resolves', async () => {
    const port = await listen();
    const probeScope = juiceShopScopeRules(new URL(`http://127.0.0.1:${port}`));
    const egress = createLabEgress({ scope: probeScope, fetcher: vi.fn<Fetcher>() });

    await expect(egress.probe('127.0.0.1', port)).resolves.toBeUndefined();
  });

  it('rejects a probe to a closed in-scope port', async () => {
    const port = await listen();
    await closeAll();
    const probeScope = juiceShopScopeRules(new URL(`http://127.0.0.1:${port}`));
    const egress = createLabEgress({ scope: probeScope, fetcher: vi.fn<Fetcher>() });

    await expect(egress.probe('127.0.0.1', port)).rejects.toThrow();
  });

  it('blocks a probe to a host that is not a verified lab before connecting', async () => {
    const egress = createLabEgress({ scope, fetcher: vi.fn<Fetcher>() });

    await expect(egress.probe('example.com', 80)).rejects.toBeInstanceOf(ScopeViolationError);
  });
});

describe('createLocalSandboxProvider', () => {
  it('provisions a sandbox with the requested digest and a unique id each time', async () => {
    const provider = createLocalSandboxProvider();
    const digest = `sha256:${'a'.repeat(64)}`;
    const first = await provider.provision({ imageDigest: digest, proxyUrl: 'http://egress:3128' });
    const second = await provider.provision({
      imageDigest: digest,
      proxyUrl: 'http://egress:3128',
    });

    expect(first.imageDigest).toBe(digest);
    expect(first.id).not.toBe(second.id);
    await expect(first.terminate()).resolves.toBeUndefined();
  });
});
