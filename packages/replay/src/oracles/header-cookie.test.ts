import { describe, expect, it } from 'vitest';

import { exchange, header, observation } from './fixtures.js';
import { evaluateHeaderCookie, parseSetCookie } from './header-cookie.js';

const cookieCheck = (name: string, attribute: 'HttpOnly' | 'Secure' | 'SameSite') => ({
  target: 'cookie' as const,
  name,
  expectation: 'present' as const,
  attribute,
});
const run = (headers: ReturnType<typeof header>[], assertions: unknown[]) =>
  evaluateHeaderCookie(observation([exchange({ headers })]), { assertions });

describe('parseSetCookie', () => {
  it('reads the name and lowercased attribute names, never the value', () => {
    const cookie = parseSetCookie('session=s3cr3t-value; Path=/; httponly; SameSite=Lax');
    expect(cookie.name).toBe('session');
    expect([...cookie.attributes].sort()).toEqual(['httponly', 'path', 'samesite']);
  });
});

describe('evaluateHeaderCookie', () => {
  describe('cookie attributes', () => {
    it('fires when a set cookie lacks a required HttpOnly attribute', () => {
      expect(
        run(
          [header('set-cookie', 'session=abc; Path=/; Secure; SameSite=Lax')],
          [cookieCheck('session', 'HttpOnly')],
        ),
      ).toEqual({ matched: true, reason: 'cookie_attribute_missing' });
    });

    it('fires when the Secure or SameSite attribute is missing', () => {
      const headers = [header('set-cookie', 'session=abc; HttpOnly')];
      expect(run(headers, [cookieCheck('session', 'Secure')]).matched).toBe(true);
      expect(run(headers, [cookieCheck('session', 'SameSite')]).matched).toBe(true);
    });

    it('does not fire when every required attribute is set', () => {
      expect(
        run(
          [header('set-cookie', 'session=abc; HttpOnly; Secure; SameSite=Strict')],
          [
            cookieCheck('session', 'HttpOnly'),
            cookieCheck('session', 'Secure'),
            cookieCheck('session', 'SameSite'),
          ],
        ),
      ).toEqual({ matched: false, reason: 'all_assertions_hold' });
    });

    it('does not fire for a cookie the probe did not set', () => {
      expect(run([header('set-cookie', 'other=1')], [cookieCheck('session', 'HttpOnly')])).toEqual({
        matched: false,
        reason: 'all_assertions_hold',
      });
    });

    it('does not match a cookie whose name only starts with the declared name', () => {
      expect(
        run([header('set-cookie', 'session_id=abc')], [cookieCheck('session', 'HttpOnly')]).matched,
      ).toBe(false);
    });

    it('judges each Set-Cookie header separately, so one unsafe cookie fires', () => {
      expect(
        run(
          [header('set-cookie', 'session=a; HttpOnly'), header('set-cookie', 'session=b; Path=/')],
          [cookieCheck('session', 'HttpOnly')],
        ).matched,
      ).toBe(true);
    });

    it('fires when a cookie carries an attribute declared absent', () => {
      expect(
        run(
          [header('set-cookie', 'session=a; HttpOnly')],
          [{ target: 'cookie', name: 'session', expectation: 'absent', attribute: 'HttpOnly' }],
        ),
      ).toEqual({ matched: true, reason: 'cookie_attribute_present' });
    });
  });

  describe('header presence and values', () => {
    it('fires when a required security header is missing (HSTS)', () => {
      expect(
        run(
          [header('content-type', 'text/html')],
          [{ target: 'header', name: 'Strict-Transport-Security', expectation: 'present' }],
        ),
      ).toEqual({ matched: true, reason: 'header_missing' });
    });

    it('does not fire when a required header is present, whatever its value', () => {
      expect(
        run(
          [header('strict-transport-security', 'max-age=31536000')],
          [{ target: 'header', name: 'Strict-Transport-Security', expectation: 'present' }],
        ).matched,
      ).toBe(false);
    });

    it('fires when a forbidden header is present', () => {
      expect(
        run(
          [header('server', 'nginx/1.25')],
          [{ target: 'header', name: 'Server', expectation: 'absent' }],
        ),
      ).toEqual({ matched: true, reason: 'header_present' });
    });

    it('flags a permissive CORS origin of * but not a missing CORS header', () => {
      const cors = [
        {
          target: 'header',
          name: 'Access-Control-Allow-Origin',
          expectation: 'not_value',
          disallowedValue: '*',
        },
      ];
      expect(run([header('access-control-allow-origin', '*')], cors)).toEqual({
        matched: true,
        reason: 'header_value_disallowed',
      });
      expect(run([header('access-control-allow-origin', ' * ')], cors).matched).toBe(true);
      expect(run([header('access-control-allow-origin', 'https://app.test')], cors)).toEqual({
        matched: false,
        reason: 'all_assertions_hold',
      });
      expect(run([], cors).matched).toBe(false);
    });
  });

  it('fires on a combined check when any one assertion fails, naming the first failure', () => {
    const verdict = run(
      [
        header('set-cookie', 'session=a; HttpOnly; SameSite=Lax'),
        header('access-control-allow-origin', '*'),
      ],
      [
        cookieCheck('session', 'HttpOnly'),
        cookieCheck('session', 'Secure'),
        {
          target: 'header',
          name: 'Access-Control-Allow-Origin',
          expectation: 'not_value',
          disallowedValue: '*',
        },
      ],
    );
    expect(verdict).toEqual({ matched: true, reason: 'cookie_attribute_missing' });
  });

  it('reports no observation when the transport returned no headers', () => {
    expect(
      evaluateHeaderCookie(observation([exchange()]), {
        assertions: [{ target: 'header', name: 'Server', expectation: 'absent' }],
      }),
    ).toEqual({ matched: false, reason: 'no_observation' });
  });

  it('reports no observation for an empty observation', () => {
    expect(
      evaluateHeaderCookie(observation([]), {
        assertions: [{ target: 'header', name: 'Server', expectation: 'absent' }],
      }),
    ).toEqual({ matched: false, reason: 'no_observation' });
  });

  it('fails closed for malformed params', () => {
    expect(
      evaluateHeaderCookie(observation([exchange({ headers: [] })]), { assertions: [] }),
    ).toEqual({
      matched: false,
      reason: 'invalid_params',
    });
  });
});
