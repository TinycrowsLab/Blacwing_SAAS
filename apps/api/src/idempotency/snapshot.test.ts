import { describe, expect, it } from 'vitest';

import { buildSnapshot, headerSubset, isCacheableStatus } from './snapshot.js';

const json = { 'content-type': 'application/json; charset=utf-8' };

describe('isCacheableStatus', () => {
  it.each([200, 201, 202, 204, 400, 404, 410, 412, 413, 415, 422])('caches %i', (status) => {
    expect(isCacheableStatus(status)).toBe(true);
  });

  it.each([100, 301, 302, 304, 401, 403, 408, 409, 423, 425, 429, 500, 502, 503, 504])(
    'never caches %i',
    (status) => {
      expect(isCacheableStatus(status)).toBe(false);
    },
  );
});

describe('headerSubset', () => {
  it('keeps only the replayable headers', () => {
    expect(
      headerSubset({
        'content-type': 'application/json',
        location: '/v1/runs/run_1',
        etag: '"v1"',
        'set-cookie': 'session=secret',
        'x-request-id': 'abc',
        'retry-after': '5',
        'content-length': 12,
        date: 'now',
      }),
    ).toEqual({ 'content-type': 'application/json', location: '/v1/runs/run_1', etag: '"v1"' });
  });

  it('ignores array and missing values', () => {
    expect(headerSubset({ location: ['a', 'b'] })).toEqual({});
  });
});

describe('buildSnapshot', () => {
  const base = { status: 201, headers: json, maxBodyBytes: 1000 };

  it('keeps a clean JSON body byte for byte', () => {
    const payload = '{ "id":  "run_1" }';
    const out = buildSnapshot({ ...base, payload });
    expect(out).toMatchObject({ kind: 'stored', redactions: 0, result: { body: payload } });
  });

  it('redacts sensitive members at any depth and secret-shaped strings', () => {
    const out = buildSnapshot({
      ...base,
      payload: JSON.stringify({
        id: 'x',
        password: 'p',
        deep: { list: [{ apiKey: 'k' }], note: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
      }),
    });
    expect(out.kind).toBe('stored');
    if (out.kind !== 'stored') return;
    expect(out.redactions).toBeGreaterThanOrEqual(2);
    expect(out.result.body).not.toContain('"p"');
    expect(out.result.body).not.toContain('"k"');
    expect(out.result.body).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(JSON.parse(out.result.body)).toMatchObject({ id: 'x', password: '[REDACTED]' });
  });

  it('measures the cap in bytes of the stored body', () => {
    const payload = JSON.stringify({ s: 'é'.repeat(100) }); // 200 bytes of é
    expect(buildSnapshot({ ...base, payload, maxBodyBytes: 150 })).toEqual({
      kind: 'omitted',
      reason: 'too_large',
    });
    expect(buildSnapshot({ ...base, payload, maxBodyBytes: 400 }).kind).toBe('stored');
  });

  it('omits types it cannot redact: binary, streams and invalid JSON', () => {
    const omitted = { kind: 'omitted', reason: 'unsupported_type' };
    expect(
      buildSnapshot({ ...base, headers: { 'content-type': 'application/pdf' }, payload: 'x' }),
    ).toEqual(omitted);
    expect(buildSnapshot({ ...base, payload: { pipe: () => undefined } })).toEqual(omitted);
    expect(buildSnapshot({ ...base, payload: '{not json' })).toEqual(omitted);
  });

  it('stores an empty body (204) regardless of type', () => {
    for (const payload of ['', null, undefined]) {
      const out = buildSnapshot({ status: 204, headers: {}, payload, maxBodyBytes: 10 });
      expect(out).toMatchObject({ kind: 'stored', result: { body: '' } });
    }
  });

  it('redacts plain text bodies and stores Buffers as text', () => {
    const out = buildSnapshot({
      ...base,
      headers: { 'content-type': 'text/plain' },
      payload: Buffer.from('hello'),
    });
    expect(out).toMatchObject({ kind: 'stored', result: { body: 'hello' } });
  });
});
