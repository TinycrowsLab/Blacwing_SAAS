import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRedactionHandler,
  isInternalAddress,
  redactionRunToken,
} from './redaction-endpoint.js';
import { createRedactionRegistry } from './redaction.js';

import type { AddressInfo } from 'node:net';

const KEY = 'platform-token-key';
const SECRET = 'Zx9!qLm2#Rt7vWp4';
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function start() {
  const registry = createRedactionRegistry({ audit: () => Promise.resolve() });
  const handler = createRedactionHandler({ registry, tokenKey: KEY });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    method: string,
    runId: string,
    opts: { token?: string | null; tenant?: string; body?: unknown } = {},
  ) => {
    const tenant = opts.tenant ?? 'tenant-a';
    const token = opts.token === undefined ? redactionRunToken(KEY, tenant, runId) : opts.token;
    return fetch(`${base}/internal/runs/${runId}/redaction`, {
      method,
      headers: {
        'x-tenant-id': tenant,
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  };
  return { registry, call };
}

describe('redaction endpoint', () => {
  it('registers, redacts, reports and purges without echoing values', async () => {
    const { call } = await start();
    const reg = await call('POST', 'r1', { body: { op: 'register', label: 'db', value: SECRET } });
    expect(await reg.json()).toEqual({ registered: true });
    const red = await call('POST', 'r1', { body: { op: 'redact', text: `x ${SECRET}` } });
    expect(await red.json()).toEqual({ text: 'x ***REDACTED:db***', hits: 1, truncated: false });
    const get = await call('GET', 'r1');
    const info = await get.text();
    expect(JSON.parse(info)).toEqual({ exists: true, size: 1 });
    expect(info).not.toContain(SECRET);
    expect((await call('DELETE', 'r1')).status).toBe(204);
    expect(await (await call('GET', 'r1')).json()).toEqual({ exists: false, size: 0 });
  });

  it('requires the run-scoped token', async () => {
    const { call } = await start();
    expect((await call('GET', 'r1', { token: null })).status).toBe(401);
    expect((await call('GET', 'r1', { token: 'nope' })).status).toBe(401);
    // A token for run r2 does not open r1, nor does one for another tenant.
    expect(
      (await call('GET', 'r1', { token: redactionRunToken(KEY, 'tenant-a', 'r2') })).status,
    ).toBe(401);
    expect(
      (await call('GET', 'r1', { token: redactionRunToken(KEY, 'tenant-b', 'r1') })).status,
    ).toBe(401);
  });

  it('rejects malformed requests', async () => {
    const { call } = await start();
    expect((await call('POST', 'r1', { body: { op: 'bogus' } })).status).toBe(400);
    expect((await call('POST', 'r1', { body: { op: 'register', label: 'db' } })).status).toBe(400);
    expect((await call('PUT', 'r1')).status).toBe(405);
  });

  it('refuses peers outside the run network', () => {
    for (const ok of [
      '127.0.0.1',
      '::1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '::ffff:10.0.0.1',
      'fd00::1',
    ]) {
      expect(isInternalAddress(ok)).toBe(true);
    }
    for (const bad of ['8.8.8.8', '172.32.0.1', '2001:db8::1', 'garbage', undefined]) {
      expect(isInternalAddress(bad)).toBe(false);
    }
  });
});
