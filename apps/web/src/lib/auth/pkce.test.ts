import { describe, expect, it } from 'vitest';

import { codeChallenge, randomToken, safeEqual, sanitizeReturnTo } from './pkce.js';

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636 appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates 256-bit url-safe tokens that never repeat', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('compares in constant time semantics (equal, different, different length)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });
});

describe('sanitizeReturnTo', () => {
  it('keeps internal paths with their query', () => {
    expect(sanitizeReturnTo('/runs/abc?tab=events')).toBe('/runs/abc?tab=events');
    expect(sanitizeReturnTo('/')).toBe('/');
  });

  it.each([
    ['absolute url', 'https://evil.example/'],
    ['protocol-relative', '//evil.example/x'],
    ['backslash trick', '/\\evil.example'],
    ['slash backslash', '/\\/evil.example'],
    ['no leading slash', 'evil.example'],
    ['script scheme', ['javascript', 'alert(1)'].join(':')],
    ['encoded newline', '/ok\r\nSet-Cookie: a=b'],
    ['tab', '/a\tb'],
    ['nul', '/a\u0000b'],
    ['auth routes', '/api/auth/logout'],
    ['auth root', '/api/auth'],
    ['empty', ''],
    ['too long', `/${'a'.repeat(3000)}`],
  ])('falls back to / for %s', (_label, raw) => {
    expect(sanitizeReturnTo(raw)).toBe('/');
  });

  it('falls back to / for null and undefined', () => {
    expect(sanitizeReturnTo(null)).toBe('/');
    expect(sanitizeReturnTo(undefined)).toBe('/');
  });
});
