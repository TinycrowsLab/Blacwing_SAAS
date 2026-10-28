import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import { credentialOf, MAX_HEADER_BYTES } from './credentials.js';

/** The AppError code a thrown credential refusal carries (`undefined` when nothing is thrown). */
function refusalCode(read: () => unknown): string | undefined {
  try {
    read();
    return undefined;
  } catch (error) {
    return isAppError(error) ? error.code : 'UNKNOWN';
  }
}

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';
const SESSION = '__Host-bw_session=sealed-session-id';

describe('credentialOf', () => {
  it('reports no credential for a request with neither header', () => {
    expect(credentialOf({})).toEqual({ kind: 'none' });
  });

  it('treats an empty session cookie as no credential', () => {
    expect(credentialOf({ cookie: '__Host-bw_session=' })).toEqual({ kind: 'none' });
    expect(credentialOf({ cookie: 'theme=dark; other=1' })).toEqual({ kind: 'none' });
  });

  it.each([
    ['a personal access token', 'Bearer bw_pat_AbC123'],
    ['a CI token', 'Bearer bw_ci_XyZ987'],
  ])('routes %s to the opaque-token path', (_name, header) => {
    const token = header.slice('Bearer '.length);
    expect(credentialOf({ authorization: header })).toEqual({ kind: 'opaque-bearer', token });
  });

  it('routes any other bearer value to the Keycloak JWT path', () => {
    expect(credentialOf({ authorization: `Bearer ${JWT}` })).toEqual({
      kind: 'jwt',
      token: JWT,
    });
  });

  it('accepts the bearer scheme in any letter case', () => {
    expect(credentialOf({ authorization: `bearer ${JWT}` })).toEqual({ kind: 'jwt', token: JWT });
  });

  it('reads the session cookie among other cookies', () => {
    expect(credentialOf({ cookie: `theme=dark; ${SESSION}; lang=en` })).toEqual({
      kind: 'session-cookie',
      cookie: 'sealed-session-id',
    });
  });

  it('prefers the Authorization bearer over a session cookie (documented precedence)', () => {
    expect(credentialOf({ authorization: 'Bearer bw_pat_AbC123', cookie: SESSION })).toEqual({
      kind: 'opaque-bearer',
      token: 'bw_pat_AbC123',
    });
    expect(credentialOf({ authorization: `Bearer ${JWT}`, cookie: SESSION })).toEqual({
      kind: 'jwt',
      token: JWT,
    });
  });

  it.each([
    ['a non-bearer scheme', { authorization: 'Basic dXNlcjpwYXNz', cookie: SESSION }],
    ['a bearer with no token', { authorization: 'Bearer ' }],
    ['a token with illegal characters', { authorization: 'Bearer ab cd' }],
    ['a token over the length bound', { authorization: `Bearer ${'a'.repeat(4097)}` }],
    [
      'an oversized Authorization header',
      { authorization: `Bearer ${'a'.repeat(MAX_HEADER_BYTES)}` },
    ],
    ['a repeated Authorization header', { authorization: ['Bearer a.b.c', 'Bearer d.e.f'] }],
  ])('refuses %s and never falls through to the cookie', (_name, headers) => {
    expect(refusalCode(() => credentialOf(headers))).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses two session cookies rather than picking one', () => {
    expect(refusalCode(() => credentialOf({ cookie: `${SESSION}; ${SESSION}` }))).toBe(
      'AUTH_INVALID_TOKEN',
    );
  });

  it('refuses an oversized or repeated Cookie header', () => {
    expect(refusalCode(() => credentialOf({ cookie: `x=${'a'.repeat(MAX_HEADER_BYTES)}` }))).toBe(
      'AUTH_INVALID_TOKEN',
    );
    expect(refusalCode(() => credentialOf({ cookie: ['a=1', 'b=2'] }))).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses an oversized session cookie value', () => {
    expect(
      refusalCode(() => credentialOf({ cookie: `__Host-bw_session=${'a'.repeat(4097)}` })),
    ).toBe('AUTH_INVALID_TOKEN');
  });
});
