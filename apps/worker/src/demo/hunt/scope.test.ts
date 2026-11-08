import { describe, expect, it } from 'vitest';

import { checkScope, classifyMethod, gateKey, stateChangeHint } from './scope.js';

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

describe('state-changing GET ask-list', () => {
  const u = (path: string): URL => new URL(`https://shop.example.com${path}`);

  it.each([
    ['/rest/user/change-password?new=x', 'change'],
    ['/logout', 'logout'],
    ['/vulnerabilities/csrf/?password_new=a&Change=Change', 'password'],
    ['/api/items/7?action=archive', 'action='],
    ['/index.php?DO=x', 'do='],
    ['/account/Sign-Out', 'sign-out'],
  ])('GET %s needs Gate 2 (%s)', (path, word) => {
    expect(stateChangeHint('GET', u(path))).toBe(word);
    expect(classifyMethod('GET', u(path))).toBe('state_changing');
    expect(classifyMethod('head', u(path))).toBe('state_changing');
  });

  it('leaves ordinary reads, OPTIONS and calls without a URL alone', () => {
    for (const path of ['/rest/products/search?q=apple', '/api/Users/1', '/robots.txt']) expect(classifyMethod('GET', u(path))).toBe('active_safe');
    expect(classifyMethod('OPTIONS', u('/logout'))).toBe('active_safe');
    expect(classifyMethod('GET')).toBe('active_safe');
    expect(stateChangeHint('POST', u('/logout'))).toBeNull();
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
    for (const path of ['/admin', '/admin/users', '/ADMIN/x', '/billing', '/public/../admin/x', '/public/%2e%2e/admin', '/admin%2Fusers', '/%61dmin']) {
      expect(checkScope(`https://shop.example.com${path}`, scope)).toEqual({ ok: false, rule: 'excluded_path' });
    }
    expect(checkScope('https://shop.example.com/administrator', scope).ok).toBe(true);
  });

  it('refuses canonicalisation bypasses of an exclusion (double encoding, //, ;params, backslash)', () => {
    for (const path of ['//admin', '/x/..//admin', '/admin;x', '/admin;jsessionid=1/users', '/%2561dmin', '/%252561dmin', '/%5Cadmin', '/public%2F..%2Fadmin', '/./admin/']) {
      expect(checkScope(`https://shop.example.com${path}`, scope), path).toEqual({ ok: false, rule: 'excluded_path' });
    }
    expect(checkScope('https://shop.example.com/public;v=1/admin-guide', scope).ok).toBe(true);
  });

  it('refuses control bytes in any decoded form of the path', () => {
    for (const path of ['/admin%00', '/internal%00.json', '/a%0d%0aX-Injected:1', '/a%2500', '/a%7f']) {
      expect(checkScope(`https://shop.example.com${path}`, scope), path).toEqual({ ok: false, rule: 'invalid_path' });
    }
  });

  it('keys Gate 2 approvals on method, origin, path without the query, and the test account role', () => {
    const verdict = checkScope('https://shop.example.com/api/x?a=1', scope);
    if (!verdict.ok) throw new Error('expected ok');
    expect(gateKey('post', verdict.url)).toBe('POST https://shop.example.com/api/x as no test account');
    expect(gateKey('post', verdict.url, 'Admin')).toBe('POST https://shop.example.com/api/x as admin');
  });
});
