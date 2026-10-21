import { describe, expect, it } from 'vitest';

import { createTextRedactor, isSecretKey, redactValue, REDACTION_MAX_DEPTH } from './redact.js';

describe('isSecretKey', () => {
  it.each([
    'password',
    'dbPassword',
    'client_secret',
    'API-KEY',
    'apiKey',
    'Authorization',
    'token',
    'access_token',
    'set-cookie',
  ])('flags %s', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });
  it.each(['tokenId', 'tokenRef', 'decision', 'secretRefId', 'author', 'keyId'])(
    'keeps %s',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );
});

describe('redactValue', () => {
  const redact = createTextRedactor((text) => text.replaceAll('s3cret', '[REDACTED]'));

  it('redacts strings in nested arrays and objects without mutating the input', () => {
    const input = { a: ['x s3cret', { b: 's3cret' }], n: 1, ok: true, z: null };
    const out = redactValue(input, redact);
    expect(out).toEqual({ a: ['x [REDACTED]', { b: '[REDACTED]' }], n: 1, ok: true, z: null });
    expect(input.a[0]).toBe('x s3cret');
  });

  it('keeps null secret-key values and replaces others whole', () => {
    expect(redactValue({ password: null, secret: { deep: 1 } }, redact)).toEqual({
      password: null,
      secret: '[REDACTED]',
    });
  });

  it('refuses nesting past the depth limit', () => {
    let deep: unknown = 'x';
    for (let i = 0; i <= REDACTION_MAX_DEPTH; i += 1) deep = { d: deep };
    expect(() => redactValue(deep, redact)).toThrow(/nested deeper/);
  });

  it('redacts JWTs, Slack and Anthropic keys and PEM blocks', () => {
    const text =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk xoxb-1234567890-abcdef sk-ant-api03-abcdefghijkl -----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----';
    const out = createTextRedactor()(text);
    for (const leaked of ['eyJhbGci', 'xoxb-', 'sk-ant-', 'MIIB'])
      expect(out).not.toContain(leaked);
  });

  it('fails closed on a registry that returns a non-string', () => {
    expect(createTextRedactor((() => 42) as never)('anything')).toBe('[REDACTED]');
  });
});
