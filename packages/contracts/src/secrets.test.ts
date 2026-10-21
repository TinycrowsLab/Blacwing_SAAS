import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_SECRET_BACKENDS,
  formatSecretRef,
  isSecretRefError,
  parseSecretRef,
  resolveSecretVersion,
  SECRET_BACKENDS,
  SECRET_NAME_MAX,
  SecretRefError,
  secretNameSchema,
  secretRefSchema,
} from './secrets.js';

const TENANT = '0190f6a2-7b1c-7d2e-8f3a-123456789abc';
const SECRET = '0190f6a2-7b1c-7d2e-8f3a-abcdef012345';

/** The error `fn` throws, or undefined when it does not throw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseSecretRef', () => {
  it('parses the issue example', () => {
    expect(parseSecretRef('bw-secret://t/s?v=2')).toEqual({
      tenantId: 't',
      secretId: 's',
      version: 2,
    });
  });

  it('leaves the version absent when none is pinned (the resolver defaults it)', () => {
    const ref = parseSecretRef(`bw-secret://${TENANT}/${SECRET}`);
    expect(ref).toEqual({ tenantId: TENANT, secretId: SECRET });
    expect('version' in ref).toBe(false);
    expect(resolveSecretVersion(ref, 5)).toBe(5);
    expect(resolveSecretVersion({ ...ref, version: 2 }, 5)).toBe(2);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['wrong scheme', 'https://t/s'],
    ['scheme case', 'BW-SECRET://t/s'],
    ['no slashes', 'bw-secret:t/s'],
    ['missing secret', 'bw-secret://t'],
    ['missing secret with slash', 'bw-secret://t/'],
    ['missing tenant', 'bw-secret:///s'],
    ['extra segment', 'bw-secret://t/s/x'],
    ['trailing slash', 'bw-secret://t/s/'],
    ['dot-dot segment', 'bw-secret://t/..'],
    ['credentials', 'bw-secret://user@t/s'],
    ['port', 'bw-secret://t:80/s'],
    ['fragment', 'bw-secret://t/s#frag'],
    ['whitespace', 'bw-secret://t/s '],
    ['newline', 'bw-secret://t/s\n'],
    ['unicode', 'bw-secret://t/s\u00e9'],
    ['percent encoding', 'bw-secret://t/%73'],
    ['empty query', 'bw-secret://t/s?'],
    ['unknown parameter', 'bw-secret://t/s?x=1'],
    ['two parameters', 'bw-secret://t/s?v=1&x=2'],
    ['double query', 'bw-secret://t/s?v=1?v=2'],
    ['version zero', 'bw-secret://t/s?v=0'],
    ['negative version', 'bw-secret://t/s?v=-1'],
    ['leading zero version', 'bw-secret://t/s?v=01'],
    ['fractional version', 'bw-secret://t/s?v=1.5'],
    ['non-numeric version', 'bw-secret://t/s?v=abc'],
    ['empty version', 'bw-secret://t/s?v='],
    ['version above int4', 'bw-secret://t/s?v=2147483648'],
    ['huge version', 'bw-secret://t/s?v=99999999999999999999'],
    ['over-long segment', `bw-secret://${'a'.repeat(65)}/s`],
  ])('rejects %s with INVALID_SECRET_REF', (_label, value) => {
    const error = thrownBy(() => parseSecretRef(value));
    expect(error).toBeInstanceOf(SecretRefError);
    expect(isSecretRefError(error)).toBe(true);
    expect((error as SecretRefError).code).toBe('INVALID_SECRET_REF');
  });

  it('does not echo the rejected input in the error message', () => {
    const error = thrownBy(() => parseSecretRef('bw-secret://hunter2-token/x/y'));
    expect((error as Error).message).not.toContain('hunter2');
  });
});

describe('formatSecretRef', () => {
  it('round-trips with and without a version', () => {
    for (const ref of [
      { tenantId: TENANT, secretId: SECRET },
      { tenantId: TENANT, secretId: SECRET, version: 7 },
    ]) {
      expect(parseSecretRef(formatSecretRef(ref))).toEqual(ref);
    }
    expect(formatSecretRef({ tenantId: 't', secretId: 's', version: 2 })).toBe(
      'bw-secret://t/s?v=2',
    );
  });

  it('refuses a ref that would not parse back', () => {
    expect(() => formatSecretRef({ tenantId: 't/x', secretId: 's' })).toThrow(SecretRefError);
    expect(() => formatSecretRef({ tenantId: 't', secretId: 's', version: 0 })).toThrow(
      SecretRefError,
    );
    expect(() => formatSecretRef({ tenantId: 't', secretId: 's', version: 1.5 })).toThrow(
      SecretRefError,
    );
  });
});

describe('secretRefSchema', () => {
  it('parses to a SecretRef and rejects malformed input as a validation issue', () => {
    expect(secretRefSchema.parse('bw-secret://t/s')).toEqual({ tenantId: 't', secretId: 's' });
    expect(secretRefSchema.safeParse('nope').success).toBe(false);
    expect(secretRefSchema.safeParse(1).success).toBe(false);
  });
});

describe('secretNameSchema', () => {
  it('NFC-normalises so canonically equal names collide', () => {
    expect(secretNameSchema.parse('café')).toBe('caf\u00e9');
    expect(secretNameSchema.parse('prod/db password')).toBe('prod/db password');
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(SECRET_NAME_MAX + 1)],
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['tab', 'a\tb'],
    ['DEL', 'a\u007fb'],
    ['C1 control', 'a\u0085b'],
    ['line separator', 'a\u2028b'],
  ])('rejects %s', (_label, value) => {
    expect(secretNameSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the maximum length', () => {
    expect(secretNameSchema.safeParse('a'.repeat(SECRET_NAME_MAX)).success).toBe(true);
  });
});

describe('backends', () => {
  it('every external backend is a known backend, and openbao is the internal one', () => {
    for (const backend of EXTERNAL_SECRET_BACKENDS) expect(SECRET_BACKENDS).toContain(backend);
    expect(EXTERNAL_SECRET_BACKENDS as readonly string[]).not.toContain('openbao');
  });
});
