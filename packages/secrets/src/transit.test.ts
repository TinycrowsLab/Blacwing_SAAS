import { describe, expect, it } from 'vitest';

import { createTransit } from './transit.js';

import type { OpenBaoClient, OpenBaoResponse } from './openbao.js';

function client(res: OpenBaoResponse | Error) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const bao: OpenBaoClient = {
    request(method, path, body) {
      calls.push({ method, path, body });
      return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
    },
  };
  return { calls, transit: createTransit(bao) };
}

describe('createTransit', () => {
  it('posts to the right transit path and reads the ciphertext', async () => {
    const { calls, transit } = client({ status: 200, data: { ciphertext: 'vault:v2:abc' } });
    await expect(transit.encrypt('tenant-x', 'QQ==')).resolves.toBe('vault:v2:abc');
    await expect(transit.rewrap('tenant-x', 'vault:v1:z')).resolves.toBe('vault:v2:abc');
    expect(calls).toEqual([
      { method: 'POST', path: 'transit/encrypt/tenant-x', body: { plaintext: 'QQ==' } },
      { method: 'POST', path: 'transit/rewrap/tenant-x', body: { ciphertext: 'vault:v1:z' } },
    ]);
  });

  it('reads the plaintext from decrypt', async () => {
    const { calls, transit } = client({ status: 200, data: { plaintext: 'QQ==' } });
    await expect(transit.decrypt('k', 'vault:v1:z')).resolves.toBe('QQ==');
    expect(calls[0]?.path).toBe('transit/decrypt/k');
  });

  it.each([
    ['missing key (404)', { status: 404, data: undefined }],
    ['empty data', { status: 200, data: {} }],
    ['wrong field type', { status: 200, data: { ciphertext: 5 } }],
  ])('fails closed with KEK_UNAVAILABLE on %s', async (_n, res) => {
    const { transit } = client(res);
    await expect(transit.encrypt('k', 'QQ==')).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
  });

  it('propagates client errors untouched', async () => {
    const { transit } = client(new Error('boom'));
    await expect(transit.decrypt('k', 'c')).rejects.toThrow('boom');
  });
});
