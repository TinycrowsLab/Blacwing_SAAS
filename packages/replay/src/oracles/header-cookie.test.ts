import { describe, expect, it } from 'vitest';

import { exchange, header, observation } from './fixtures.js';
import { evaluateHeaderCookie, parseSetCookie } from './header-cookie.js';

const HSTS = {
  target: 'header',
  name: 'Strict-Transport-Security',
  expectation: 'present',
} as const;
const CORS = {
  target: 'header',
  name: 'Access-Control-Allow-Origin',
  expectation: 'present',
  disallowedValue: '*',
} as const;
const SESSION_HTTP_ONLY = {
  target: 'cookie',
  name: 'session',
  expectation: 'present',
  attribute: 'HttpOnly',
} as const;

function probe(headers: readonly { name: string; value: string }[]) {
  return observation([exchange({ headers })]);
}

describe('evaluateHeaderCookie: headers', () => {
  it('fires when a required security header is missing', () => {
    expect(evaluateHeaderCookie(probe([]), HSTS)).toEqual({
      matched: true,
      reason: 'header_missing',
    });
  });

  it('does not fire when the required header is present, whatever its case', () => {
    expect(
      evaluateHeaderCookie(probe([header('strict-transport-security', 'max-age=31536000')]), HSTS),
    ).toEqual({ matched: false, reason: 'header_present' });
  });

  it('fires on a permissive CORS wildcard, and not on a specific origin', () => {
    expect(evaluateHeaderCookie(probe([header('access-control-allow-origin', '*')]), CORS)).toEqual(
      {
        matched: true,
        reason: 'header_value_disallowed',
      },
    );
    expect(
      evaluateHeaderCookie(
        probe([header('access-control-allow-origin', 'https://app.example')]),
        CORS,
      ),
    ).toEqual({ matched: false, reason: 'header_present' });
  });

  it('fires when a forbidden header is present (expectation absent) and not when it is absent', () => {
    const serverBanner = { target: 'header', name: 'Server', expectation: 'absent' } as const;
    expect(evaluateHeaderCookie(probe([header('server', 'nginx/1.25')]), serverBanner)).toEqual({
      matched: true,
      reason: 'header_present',
    });
    expect(evaluateHeaderCookie(probe([]), serverBanner)).toEqual({
      matched: false,
      reason: 'header_absent',
    });
  });
});

describe('evaluateHeaderCookie: cookie attributes', () => {
  it('fires when a set cookie lacks the required HttpOnly attribute', () => {
    expect(
      evaluateHeaderCookie(
        probe([header('set-cookie', 'session=abc; Path=/; Secure')]),
        SESSION_HTTP_ONLY,
      ),
    ).toEqual({ matched: true, reason: 'cookie_attribute_missing' });
  });

  it('does not fire when the cookie carries the attribute, in any case', () => {
    expect(
      evaluateHeaderCookie(
        probe([header('set-cookie', 'session=abc; httponly; Secure')]),
        SESSION_HTTP_ONLY,
      ),
    ).toEqual({ matched: false, reason: 'cookie_attribute_set' });
  });

  it('checks every instance of the cookie, so one weak instance fires', () => {
    expect(
      evaluateHeaderCookie(
        probe([
          header('set-cookie', 'session=abc; HttpOnly'),
          header('set-cookie', 'session=def; Secure'),
        ]),
        SESSION_HTTP_ONLY,
      ).matched,
    ).toBe(true);
  });

  it('fires on a required SameSite attribute and does not read a cookie with another name', () => {
    const sameSite = { ...SESSION_HTTP_ONLY, attribute: 'SameSite' } as const;
    expect(
      evaluateHeaderCookie(probe([header('set-cookie', 'session=abc; HttpOnly')]), sameSite)
        .matched,
    ).toBe(true);
    expect(
      evaluateHeaderCookie(probe([header('set-cookie', 'other=abc')]), SESSION_HTTP_ONLY),
    ).toEqual({ matched: false, reason: 'cookie_not_set' });
  });

  it('fires when a forbidden attribute is present (expectation absent)', () => {
    const noSecure = { ...SESSION_HTTP_ONLY, expectation: 'absent', attribute: 'Secure' } as const;
    expect(
      evaluateHeaderCookie(probe([header('set-cookie', 'session=abc; Secure')]), noSecure),
    ).toEqual({ matched: true, reason: 'cookie_attribute_present' });
  });
});

describe('evaluateHeaderCookie: observation and params', () => {
  it('returns no_observation when headers were not captured, so a missing header is not assumed', () => {
    expect(evaluateHeaderCookie(observation([exchange()]), HSTS)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
    expect(evaluateHeaderCookie(observation([]), HSTS)).toEqual({
      matched: false,
      reason: 'no_observation',
    });
  });

  it('refuses a cookie assertion without an attribute, and a disallowed value on a cookie', () => {
    expect(
      evaluateHeaderCookie(probe([]), {
        target: 'cookie',
        name: 'session',
        expectation: 'present',
      }),
    ).toEqual({ matched: false, reason: 'invalid_params' });
    expect(evaluateHeaderCookie(probe([]), { ...SESSION_HTTP_ONLY, disallowedValue: '*' })).toEqual(
      { matched: false, reason: 'invalid_params' },
    );
  });
});

describe('parseSetCookie', () => {
  it('reads the name and lowercased attribute names, and keeps the value out of the result', () => {
    const parsed = parseSetCookie('sid=s3cr3t; Path=/; HttpOnly; SameSite=Lax');
    expect(parsed.name).toBe('sid');
    expect([...parsed.attributes].sort()).toEqual(['httponly', 'path', 'samesite']);
    expect(JSON.stringify(parsed)).not.toContain('s3cr3t');
  });

  it('handles a value with no equals sign and an empty name', () => {
    expect(parseSetCookie('flag').name).toBe('flag');
    expect(parseSetCookie('=x; Secure').name).toBe('');
  });
});
