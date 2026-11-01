import { describe, expect, it } from 'vitest';

import { canonicaliseTarget, redactedTargetValue } from './targets.js';

const ok = (kind: 'url' | 'host' | 'cidr', value: string) => {
  const result = canonicaliseTarget({ kind, value });
  if (!result.ok) throw new Error(`expected ${kind} ${value} to canonicalise: ${result.reason}`);
  return result.target;
};

describe('canonicaliseTarget', () => {
  it('lower-cases the host, drops the default port and keeps the path', () => {
    expect(ok('url', 'HTTPS://App.Example.com:443/Admin/')).toMatchObject({
      kind: 'url',
      value: 'https://app.example.com/Admin',
      identity: 'app.example.com',
      scope: { host: 'app.example.com', port: 443, path: '/Admin' },
    });
  });

  it('keeps a non-default port and derives the http default port', () => {
    expect(ok('url', 'http://app.example.com:8080').scope).toMatchObject({ port: 8080 });
    expect(ok('url', 'http://app.example.com').scope).toMatchObject({ port: 80 });
  });

  it('treats an IPv4 or bracketed IPv6 URL host as an address, not a name', () => {
    const v4 = ok('url', 'https://10.20.0.5:8443/x');
    expect(v4.scope).toEqual({ ip: '10.20.0.5', port: 8443, path: '/x' });
    expect(v4.identity).toBe('10.20.0.5');
    const v6 = ok('url', 'https://[2001:db8::1]/');
    expect(v6.scope).toEqual({ ip: '2001:db8::1', port: 443, path: '/' });
    expect(v6.value).toBe('https://[2001:db8::1]/');
  });

  it('shows a URL target without userinfo, query or fragment', () => {
    expect(
      redactedTargetValue({ kind: 'url', value: 'https://u:p@App.example.com:8443/a?token=t#f' }),
    ).toBe('https://app.example.com:8443/a');
    expect(redactedTargetValue({ kind: 'url', value: 'nope' })).toBe('(malformed url)');
    expect(redactedTargetValue({ kind: 'host', value: 'app.example.com' })).toBe('app.example.com');
  });

  it('refuses non-http schemes, credentials, malformed URLs and unsafe paths', () => {
    expect(canonicaliseTarget({ kind: 'url', value: 'file:///etc/passwd' })).toEqual({
      ok: false,
      reason: 'url scheme must be http or https',
    });
    expect(canonicaliseTarget({ kind: 'url', value: 'https://u:p@app.example.com' })).toEqual({
      ok: false,
      reason: 'url carries credentials',
    });
    expect(canonicaliseTarget({ kind: 'url', value: 'https://' })).toEqual({
      ok: false,
      reason: 'malformed url',
    });
    const badPath = canonicaliseTarget({ kind: 'url', value: 'https://app.example.com/a%00b' });
    expect(badPath.ok).toBe(false);
  });

  it('canonicalises a host and refuses an IP or an invalid name', () => {
    expect(ok('host', 'APP.example.com.')).toMatchObject({
      value: 'app.example.com',
      identity: 'app.example.com',
    });
    expect(canonicaliseTarget({ kind: 'host', value: '10.0.0.1' })).toEqual({
      ok: false,
      reason: 'ip address: use kind cidr for addresses',
    });
    expect(canonicaliseTarget({ kind: 'host', value: 'bad_name!' })).toEqual({
      ok: false,
      reason: 'invalid host name',
    });
  });

  it('accepts only a single address as a cidr target and canonicalises its text', () => {
    expect(ok('cidr', '::ffff:10.0.0.9')).toMatchObject({
      value: '10.0.0.9/32',
      identity: '10.0.0.9',
      scope: { ip: '10.0.0.9' },
    });
    expect(ok('cidr', '2001:db8::7/128').value).toBe('2001:db8::7/128');
    expect(canonicaliseTarget({ kind: 'cidr', value: '10.0.0.0/24' })).toEqual({
      ok: false,
      reason: 'cidr range wider than one address; list the addresses or hosts instead',
    });
    expect(canonicaliseTarget({ kind: 'cidr', value: '10.0.0.1/24' })).toEqual({
      ok: false,
      reason: 'malformed cidr',
    });
  });
});
