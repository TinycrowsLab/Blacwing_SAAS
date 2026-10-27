import { describe, expect, it } from 'vitest';

import {
  clearCookie,
  LOGIN_COOKIE,
  readCookie,
  serializeCookie,
  SESSION_COOKIE,
} from './cookies.js';

describe('cookies', () => {
  it('are host-prefixed, httpOnly, Secure and SameSite=Lax with no Domain', () => {
    for (const name of [SESSION_COOKIE, LOGIN_COOKIE]) {
      expect(name.startsWith('__Host-')).toBe(true);
      const header = serializeCookie(name, 'v', 600);
      expect(header).toBe(`${name}=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      expect(header).not.toMatch(/Domain/i);
    }
  });

  it('omits Max-Age for a browser-session cookie', () => {
    expect(serializeCookie(SESSION_COOKIE, 'v')).not.toContain('Max-Age');
  });

  it('clears with Max-Age=0 and the same attributes', () => {
    expect(clearCookie(SESSION_COOKIE)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
  });

  it('reads one cookie out of a Cookie header', () => {
    const header = `a=1; ${SESSION_COOKIE}=abc=; other=2`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc=');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie('x-bw_session=1', 'bw_session')).toBeUndefined();
  });
});
