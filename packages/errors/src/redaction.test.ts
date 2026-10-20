import { describe, expect, it } from 'vitest';

import {
  composeRedactor,
  containsStackTrace,
  REDACTED,
  redactBuiltinSecrets,
} from './redaction.js';

describe('redactBuiltinSecrets', () => {
  it.each([
    ['a virtual model key', 'key=bwk_9fA-b_c2 used', 'key=[REDACTED] used'],
    ['a personal access token', 'token bw_pat_ABCdef123 expired', 'token [REDACTED] expired'],
    ['a CI token', '(bw_ci_x)', '([REDACTED])'],
    [
      'a bearer header value',
      'Authorization: Bearer eyJhbGciOi.abc.def',
      'Authorization: Bearer [REDACTED]',
    ],
    ['a basic header value', 'basic dXNlcjpwYXNzd29yZA==', 'basic [REDACTED]'],
    [
      'URL userinfo',
      'proxy http://bwk:pass@egress:13128/x',
      'proxy http://[REDACTED]@egress:13128/x',
    ],
    ['URL userinfo after a word character', 'x_https://u:p@h', 'x_https://[REDACTED]@h'],
    [
      'URL userinfo with a long scheme',
      `${'s'.repeat(40)}://u:p@h`,
      `${'s'.repeat(40)}://[REDACTED]@h`,
    ],
    ['URL userinfo in parentheses', '(redis://:pw@cache)', '(redis://[REDACTED]@cache)'],
    [
      'a PEM private key',
      'k=-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- done',
      'k=[REDACTED] done',
    ],
    ['an unterminated PEM private key', '-----BEGIN PRIVATE KEY-----\nMIIE...', '[REDACTED]'],
  ])('redacts %s', (_label, input, expected) => {
    expect(redactBuiltinSecrets(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Asset https://shop.example.com/login is not verified (Bearer tokens are short).';
    expect(redactBuiltinSecrets(text)).toBe(text);
  });

  it('handles every occurrence, not just the first', () => {
    expect(redactBuiltinSecrets('bwk_a bwk_b bw_pat_c')).toBe(
      `${REDACTED} ${REDACTED} ${REDACTED}`,
    );
  });

  it('stays fast on long hostile input', () => {
    const started = performance.now();
    redactBuiltinSecrets(
      `${'-----BEGIN PRIVATE KEY-----'.repeat(2000)}${'a://'.repeat(20000)}${'Bearer '.repeat(20000)}`,
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('stays linear on long runs of URL-scheme characters', () => {
    // Before the scheme was anchored, a 9 KB alphanumeric string took over a second.
    for (const text of [
      'b'.repeat(200_000),
      `http://${'a'.repeat(200_000)}`,
      'a.b'.repeat(70_000),
    ]) {
      const started = performance.now();
      expect(redactBuiltinSecrets(text)).toBe(text);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe('composeRedactor', () => {
  it('runs the registry redactor first, then the built-in patterns', () => {
    const redact = composeRedactor((text) => text.replaceAll('opensesame', REDACTED));
    expect(redact('pw opensesame key bwk_x')).toBe(`pw ${REDACTED} key ${REDACTED}`);
  });

  it('uses the built-in patterns alone without a registry', () => {
    expect(composeRedactor(undefined)('bw_ci_abc')).toBe(REDACTED);
  });

  it('returns undefined (drop the text) when the registry redactor throws or returns a non-string', () => {
    expect(
      composeRedactor(() => {
        throw new Error('x');
      })('text'),
    ).toBeUndefined();
    expect(
      composeRedactor((() => null) as unknown as (text: string) => string)('text'),
    ).toBeUndefined();
  });
});

describe('containsStackTrace', () => {
  it('detects real V8 stacks', () => {
    expect(containsStackTrace(new Error('x').stack ?? '')).toBe(true);
    expect(containsStackTrace('    at new Foo (<anonymous>)')).toBe(true);
    expect(containsStackTrace('    at Array.map (native)')).toBe(true);
    expect(containsStackTrace('prefix\r\n    at /srv/app/index.js:10:15')).toBe(true);
  });

  it('detects SpiderMonkey/JSC frames', () => {
    expect(containsStackTrace('handler@https://console/app.js:120:7')).toBe(true);
    expect(containsStackTrace('@debugger eval code:1:1')).toBe(false);
  });

  it('does not flag ordinary messages', () => {
    for (const text of [
      'Scheduled at 10:30:45 UTC',
      'Contact security@example.com',
      'Port 13128 at host egress',
      'Field "name" is required',
      '',
    ]) {
      expect(containsStackTrace(text)).toBe(false);
    }
  });
});
