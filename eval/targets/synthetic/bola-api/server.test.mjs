import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createBolaApi } from './server.mjs';

/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  server = createBolaApi();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  base = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * @param {string} path
 * @param {string | undefined} token
 */
async function get(path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: /** @type {unknown} */ (await res.json()) };
}

describe('bola-api synthetic lab', () => {
  it('answers the health probe without a token', async () => {
    assert.equal((await get('/healthz', undefined)).status, 200);
  });

  it('refuses every protected route without a token (fail closed)', async () => {
    for (const path of ['/api/v1/invoices/101', '/api/v1/users/1/profile', '/api/v1/admin/users']) {
      assert.equal((await get(path, undefined)).status, 401, path);
    }
  });

  it('refuses unknown and malformed tokens', async () => {
    assert.equal((await get('/api/v1/invoices/101', 'lab-token-nobody')).status, 401);
    assert.equal((await get('/api/v1/invoices/101', 'x y')).status, 401);
  });

  it('BOLA: any authenticated user reads another user invoice (the seeded flaw)', async () => {
    const res = await get('/api/v1/invoices/102', 'lab-token-alice');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      id: 102,
      ownerId: 2,
      amountCents: 98050,
      memo: 'bob: consulting',
    });
  });

  it('returns 404 for an unknown invoice', async () => {
    assert.equal((await get('/api/v1/invoices/999', 'lab-token-alice')).status, 404);
  });

  it('BFLA: a non-admin reads the admin user listing (the seeded flaw)', async () => {
    const res = await get('/api/v1/admin/users', 'lab-token-bob');
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body) ? res.body.length : 0, 3);
  });

  it('control: ownership is enforced on profiles, cross-user reads get 403', async () => {
    assert.equal((await get('/api/v1/users/2/profile', 'lab-token-alice')).status, 403);
    assert.equal((await get('/api/v1/users/1/profile', 'lab-token-alice')).status, 200);
  });

  it('control: an admin reads any profile', async () => {
    assert.equal((await get('/api/v1/users/1/profile', 'lab-token-admin')).status, 200);
  });

  it('rejects non-GET methods', async () => {
    const res = await fetch(`${base}/api/v1/invoices/101`, {
      method: 'POST',
      headers: { authorization: 'Bearer lab-token-alice' },
    });
    assert.equal(res.status, 405);
  });
});
