import { describe, expect, it } from 'vitest';

import { sessionRecord } from './auth.test-helpers.js';
import { CSRF_HEADER, csrfValid, jsonResponse, redirectResponse } from './http.js';

const ORIGIN = 'https://app.example.com';
const record = sessionRecord;

function request(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers });
}

describe('csrfValid', () => {
  it('accepts the session secret from the console origin, and from a client sending no Origin', () => {
    expect(
      csrfValid(request({ [CSRF_HEADER]: 'csrf-secret', origin: ORIGIN }), record, ORIGIN),
    ).toBe(true);
    expect(csrfValid(request({ [CSRF_HEADER]: 'csrf-secret' }), record, ORIGIN)).toBe(true);
  });

  it('rejects a missing, wrong or empty token', () => {
    expect(csrfValid(request({}), record, ORIGIN)).toBe(false);
    expect(csrfValid(request({ [CSRF_HEADER]: 'wrong' }), record, ORIGIN)).toBe(false);
    expect(csrfValid(request({ [CSRF_HEADER]: '' }), record, ORIGIN)).toBe(false);
  });

  it('rejects a foreign Origin or a cross-site fetch even with the right token', () => {
    const token = { [CSRF_HEADER]: 'csrf-secret' };
    expect(csrfValid(request({ ...token, origin: 'https://evil.example' }), record, ORIGIN)).toBe(
      false,
    );
    expect(csrfValid(request({ ...token, origin: 'null' }), record, ORIGIN)).toBe(false);
    expect(csrfValid(request({ ...token, 'sec-fetch-site': 'cross-site' }), record, ORIGIN)).toBe(
      false,
    );
  });
});

describe('responses', () => {
  it('are never cacheable and carry every Set-Cookie separately', () => {
    const response = jsonResponse({ a: 1 }, { cookies: ['a=1', 'b=2'] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(response.headers.get('content-type')).toBe('application/json');
  });

  it('redirects with 303 by default', () => {
    const response = redirectResponse('https://app.example.com/x');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.example.com/x');
  });
});
