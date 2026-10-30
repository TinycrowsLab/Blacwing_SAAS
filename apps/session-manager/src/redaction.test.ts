import { describe, expect, it } from 'vitest';

import { REDACTED } from '@blackwing/logger';

import { isCredentialKey, redactLogValue } from './redaction.js';

describe('redactLogValue', () => {
  it('replaces credential fields at the top level and nested, whatever their spelling', () => {
    const out = redactLogValue({
      username: 'alice',
      Password: 'hunter2',
      'set-cookie': 'sid=abc',
      set_cookie: 'sid=def',
      nested: { apiSecret: 'k', otp: '123456', keep: 'visible' },
      list: [{ mfa: 'code' }],
    });
    expect(out).toEqual({
      username: REDACTED,
      Password: REDACTED,
      'set-cookie': REDACTED,
      set_cookie: REDACTED,
      nested: { apiSecret: REDACTED, otp: REDACTED, keep: 'visible' },
      list: [{ mfa: REDACTED }],
    });
  });

  it('never keeps a recipe execution body (the pitfall named in SESSION-001)', () => {
    expect(redactLogValue({ status: 200, body: '<html>token=abc</html>' })).toEqual({
      status: 200,
      body: REDACTED,
    });
    expect(redactLogValue({ responseBody: 'x', requestBody: 'y' })).toEqual({
      responseBody: REDACTED,
      requestBody: REDACTED,
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', inner: { cookie: 'c' } };
    redactLogValue(input);
    expect(input).toEqual({ password: 'p', inner: { cookie: 'c' } });
  });

  it('scrubs a bearer-style run token that appears inside a free-text string', () => {
    const text = 'forwarded Authorization: Bearer bw_run_eyJ2IjoxfQ.c2lnbmF0dXJl';
    const out = redactLogValue({ msg: text });
    expect(JSON.stringify(out)).not.toContain('eyJ2IjoxfQ.c2lnbmF0dXJl');
  });

  it('keeps ordinary scalars and bounds recursion depth', () => {
    expect(redactLogValue(42)).toBe(42);
    expect(redactLogValue(null)).toBeNull();
    let deep: Record<string, unknown> = { leaf: 'v' };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactLogValue(deep))).toContain('[MaxDepth]');
  });

  it('classifies keys case- and separator-insensitively', () => {
    expect(isCredentialKey('X-Password')).toBe(true);
    expect(isCredentialKey('run_id')).toBe(false);
    expect(isCredentialKey('tenant_id')).toBe(false);
  });
});
