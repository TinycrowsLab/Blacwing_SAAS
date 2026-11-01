import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { LAB_FLAG, createInternalService, createSsrfLab } from './server.mjs';

/** @type {import('node:http').Server} */
let pub;
/** @type {import('node:http').Server} */
let internal;
let base = '';
let internalBase = '';

/** @param {import('node:http').Server} server */
async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${String(address.port)}`;
}

before(async () => {
  internal = createInternalService();
  internalBase = await listen(internal);
  pub = createSsrfLab();
  base = await listen(pub);
});

after(async () => {
  await new Promise((resolve) => {
    pub.close(() => {
      resolve(undefined);
    });
  });
  await new Promise((resolve) => {
    internal.close(() => {
      resolve(undefined);
    });
  });
});

/**
 * @param {unknown} body
 */
async function preview(body) {
  const res = await fetch(`${base}/api/v1/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {Record<string, unknown>} */ (await res.json()) };
}

describe('ssrf-lab synthetic lab', () => {
  it('answers the health probe', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  it('SSRF: the preview fetches an internal URL server-side and returns its body', async () => {
    const res = await preview({ url: `${internalBase}/internal/flag` });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 200);
    assert.ok(typeof res.body.preview === 'string' && res.body.preview.includes(LAB_FLAG));
  });

  it('control: non-http(s) schemes are refused with 400', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:8081/_x', 'ftp://example.test/']) {
      const res = await preview({ url });
      assert.equal(res.status, 400, url);
      assert.equal(res.body.code, 'INVALID_URL');
    }
  });

  it('rejects a missing, non-string or unparsable url', async () => {
    assert.equal((await preview({})).status, 400);
    assert.equal((await preview({ url: 42 })).status, 400);
    assert.equal((await preview({ url: 'not a url' })).status, 400);
    assert.equal((await preview('{not json')).status, 400);
  });

  it('rejects oversized bodies with 413 instead of buffering them', async () => {
    const res = await preview({ url: internalBase, padding: 'x'.repeat(4096) });
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'PAYLOAD_TOO_LARGE');
  });

  it('reports an unreachable upstream as 502 without leaking the error', async () => {
    const res = await preview({ url: 'http://127.0.0.1:1/unreachable' });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'UPSTREAM_UNREACHABLE');
  });

  it('only serves the preview on POST /api/v1/preview', async () => {
    assert.equal((await fetch(`${base}/api/v1/preview`)).status, 404);
  });

  it('the internal listener serves the flag and nothing else', async () => {
    assert.equal((await fetch(`${internalBase}/internal/flag`)).status, 200);
    assert.equal((await fetch(`${internalBase}/other`)).status, 404);
  });
});
