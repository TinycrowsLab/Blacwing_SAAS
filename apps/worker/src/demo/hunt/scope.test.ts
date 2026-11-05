import { describe, expect, it } from 'vitest';

import { checkScope, classifyMethod, gateKey } from './scope.js';

const scope = { allowedOrigins: ['https://shop.example.com', 'http://api.example.com:8080/ignored/path'], excludedPaths: ['/admin', '/Billing/'] };

describe('classifyMethod', () => {
  it.each([
    ['GET', 'active_safe'],
    ['head', 'active_safe'],
    ['OPTIONS', 'active_safe'],
    ['POST', 'state_changing'],
    ['put', 'state_changing'],
    ['PATCH', 'state_changing'],
    ['DELETE', 'destructive'],
    ['TRACE', 'destructive'],
    ['CONNECT', 'destructive'],
    ['PROPFIND', 'destructive'],
    ['', 'destructive'],
  ])('%s is %s', (method, expected) => {
    expect(classifyMethod(method)).toBe(expected);
  });
});

describe('checkScope', () => {
  it('allows an allowed origin, including an explicit port', () => {
    expect(checkScope('https://shop.example.com/rest/products?q=1', scope).ok).toBe(true);
    expect(checkScope('https://shop.example.com:443/x', scope).ok).toBe(true);
    expect(checkScope('http://api.example.com:8080/v1', scope).ok).toBe(true);
  });

  it.each([
    ['https://evil.example.org/', 'out_of_scope_origin'],
    ['http://shop.example.com/', 'out_of_scope_origin'],
    ['https://shop.example.com:8443/', 'out_of_scope_origin'],
    ['https://shop.example.com.evil.org/', 'out_of_scope_origin'],
    ['https://shop.example.com@evil.org/', 'credentials_in_url'],
    ['https://user:pw@shop.example.com/', 'credentials_in_url'],
    ['ftp://shop.example.com/', 'scheme_not_allowed'],
    ['not a url', 'invalid_url'],
  ])('refuses %s (%s)', (url, rule) => {
    expect(checkScope(url, scope)).toEqual({ ok: false, rule });
  });

  it('refuses excluded paths, their children, case variants and dot-segment tricks', () => {
    for (const path of ['/admin', '/admin/users', '/ADMIN/x', '/billing', '/public/../admin/x', '/public/%2e%2e/admin']) {
      expect(checkScope(`https://shop.example.com${path}`, scope)).toEqual({ ok: false, rule: 'excluded_path' });
    }
    expect(checkScope('https://shop.example.com/administrator', scope).ok).toBe(true);
  });

  it('keys Gate 2 approvals on method, origin and path without the query', () => {
    const verdict = checkScope('https://shop.example.com/api/x?a=1', scope);
    if (!verdict.ok) throw new Error('expected ok');
    expect(gateKey('post', verdict.url)).toBe('POST https://shop.example.com/api/x');
  });
});
