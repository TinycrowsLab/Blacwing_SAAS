import { describe, expect, it } from 'vitest';

import {
  canonicalBody,
  hashIdempotencyKey,
  idempotencyStorageKey,
  requestFingerprint,
  sha256Hex,
} from './fingerprint.js';

const base = { method: 'POST', path: '/v1/runs', query: '', rawBody: '{"a":1,"b":[1,2]}' };

describe('requestFingerprint', () => {
  it('is a sha256 hex digest and deterministic', () => {
    const fp = requestFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(requestFingerprint({ ...base })).toBe(fp);
  });

  it('ignores JSON member order and whitespace, in nested objects too', () => {
    const a = requestFingerprint({ ...base, rawBody: '{"a":{"x":1,"y":2},"b":[1,2]}' });
    const b = requestFingerprint({ ...base, rawBody: '{ "b": [1, 2],\n "a": {"y":2, "x":1} }' });
    expect(a).toBe(b);
  });

  it('distinguishes array order, values, method, path and query', () => {
    const fp = requestFingerprint(base);
    expect(requestFingerprint({ ...base, rawBody: '{"a":1,"b":[2,1]}' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, rawBody: '{"a":2,"b":[1,2]}' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, method: 'PUT' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, path: '/v1/exports' })).not.toBe(fp);
    expect(requestFingerprint({ ...base, query: 'dry_run=true' })).not.toBe(fp);
  });

  it('normalises the method case and the order of query parameters', () => {
    expect(requestFingerprint({ ...base, method: 'post' })).toBe(requestFingerprint(base));
    expect(requestFingerprint({ ...base, query: 'a=1&b=2&a=0' })).toBe(
      requestFingerprint({ ...base, query: 'b=2&a=0&a=1' }),
    );
  });

  it('cannot be forged by moving bytes between fields', () => {
    expect(requestFingerprint({ ...base, path: '/v1/runs', rawBody: '1' })).not.toBe(
      requestFingerprint({ ...base, path: '/v1/runs1', rawBody: '' }),
    );
  });

  it('treats an empty or absent body the same, and non-JSON bodies by their exact bytes', () => {
    expect(requestFingerprint({ ...base, rawBody: undefined })).toBe(
      requestFingerprint({ ...base, rawBody: '' }),
    );
    expect(canonicalBody('plain text')).toBe(`raw:${sha256Hex('plain text')}`);
    expect(canonicalBody('plain text')).not.toBe(canonicalBody('plain  text'));
    expect(canonicalBody(Buffer.from([0xff, 0xfe, 0x00]))).toMatch(/^raw:[0-9a-f]{64}$/);
  });

  it('accepts a Buffer body like the adapter provides', () => {
    expect(requestFingerprint({ ...base, rawBody: Buffer.from(base.rawBody) })).toBe(
      requestFingerprint(base),
    );
  });
});

describe('storage key', () => {
  it('is idem:{tenant}:{route}:{sha256(key)}', () => {
    const hash = hashIdempotencyKey('client-key-0001');
    expect(hash).toBe(sha256Hex('client-key-0001'));
    expect(idempotencyStorageKey('t1', '/v1/runs', hash)).toBe(`idem:t1:/v1/runs:${hash}`);
  });

  it('differs per tenant and per route for the same client key', () => {
    const hash = hashIdempotencyKey('client-key-0001');
    const a = idempotencyStorageKey('t1', '/v1/runs', hash);
    expect(idempotencyStorageKey('t2', '/v1/runs', hash)).not.toBe(a);
    expect(idempotencyStorageKey('t1', '/v1/exports', hash)).not.toBe(a);
  });
});
