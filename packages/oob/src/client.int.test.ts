// Integration: the client against the pinned interactsh-server (INFRA-010), started by Testcontainers with
// the same arguments as the dev compose stack. It proves the whole path the polling worker relies on:
// register, a real inbound HTTP interaction on the per-session host, poll, RSA/AES decryption, correlation,
// deregister. Needs Docker; runs only under `pnpm test:int`.
import { request } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppError } from '@blackwing/errors';
import { type InteractshHandle, withInteractsh } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { OobClient } from './client.js';
import { INTERACTSH_PROTOCOL_VERSION } from './protocol.js';

/** Per-test nonces (13 lowercase alphanumerics), as OOB-003 mints them. */
const NONCE_ONE = 'tokenabc12345';
const NONCE_TWO = 'tokenxyz98765';

let listener: InteractshHandle | undefined;
const server = (): InteractshHandle => {
  if (listener === undefined) throw new Error('withInteractsh did not start');
  return listener;
};

beforeAll(async () => {
  listener = await withInteractsh();
});
afterAll(async () => {
  await listener?.stop();
});
surfaceContainerLogsOnFailure(() => [listener]);

/** Sends an HTTP request whose Host header names the session host, as a target would call back. */
function callBack(host: string, path: string): Promise<number> {
  const { port } = new URL(server().url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function newClient(): OobClient {
  return new OobClient({
    serverUrl: server().url,
    token: server().token,
    domain: server().domain,
  });
}

describe('OobClient against the pinned interactsh-server', () => {
  it('reports the pinned protocol version the server advertises', async () => {
    const response = await fetch(`${server().url}/`);
    expect(response.headers.get('x-interactsh-version')).toBe(INTERACTSH_PROTOCOL_VERSION);
  });

  it('registers, receives a real HTTP interaction, polls it decrypted and correlated, then deregisters', async () => {
    const client = newClient();
    await client.register();

    expect(await client.poll()).toEqual([]);

    const host = client.hostFor(NONCE_ONE);
    const status = await callBack(host, '/oob-proof?x=1');
    expect(status).toBe(200);

    const batch = await client.poll();
    expect(batch).toHaveLength(1);
    const [interaction] = batch;
    expect(interaction).toMatchObject({
      protocol: 'http',
      correlationId: client.correlationId,
    });
    expect(interaction?.fullId.startsWith(client.correlationId)).toBe(true);
    expect(interaction?.remoteAddress).not.toBe('');
    const request = Buffer.from(interaction?.rawRequest ?? '', 'base64').toString('utf8');
    expect(request).toContain('GET /oob-proof?x=1 HTTP/1.1');
    expect(request).toContain(host);
    expect(interaction?.receivedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(interaction?.timestamp.getTime() ?? Number.NaN)).toBe(false);

    expect(await client.poll()).toEqual([]);

    await client.deregister();
    expect((await errorOf(client.poll())).code).toBe('OOB_POLL_FAILED');
  });

  it('never returns another session interaction to this client', async () => {
    const mine = newClient();
    const theirs = newClient();
    await mine.register();
    await theirs.register();

    await callBack(theirs.hostFor(NONCE_TWO), '/someone-else');

    expect(await mine.poll()).toEqual([]);
    const theirBatch = await theirs.poll();
    expect(theirBatch).toHaveLength(1);
    expect(theirBatch[0]?.correlationId).toBe(theirs.correlationId);

    await mine.deregister();
    await theirs.deregister();
  });

  it('refuses a wrong token at registration with OOB_REGISTER_FAILED', async () => {
    const client = new OobClient({
      serverUrl: server().url,
      token: 'not-the-token',
      domain: server().domain,
    });
    expect((await errorOf(client.register())).code).toBe('OOB_REGISTER_FAILED');
  });
});
