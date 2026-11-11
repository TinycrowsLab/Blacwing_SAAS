import { describe, expect, it } from 'vitest';

import { checkScope, classifyMethod, gateKey, setsNewPassword, stateChangeHint } from './scope.js';

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
    ['/api/v1/users?_method=PUT', '_method='],
    ['/users/v1/admin/promote', 'promote'],
    ['/api/Feedbacks/1/approve', 'approve'],
    ['/rest/basket/1/checkout', 'checkout'],
    ['/rest/user/erasure-request', 'erasure'],
    ['/rest/wallet/balance?add=100', 'add'],
    ['/setup.php?create_db=1', 'create'],
  ])('GET %s needs Gate 2 (%s)', (path, word) => {
    expect(stateChangeHint('GET', u(path))).toBe(word);
    expect(classifyMethod('GET', u(path))).toBe('state_changing');
    expect(classifyMethod('head', u(path))).toBe('state_changing');
  });

  it('leaves ordinary reads, OPTIONS and calls without a URL alone', () => {
    for (const path of ['/rest/products/search?q=apple', '/api/Users/1', '/robots.txt', '/vulnerabilities/fi/?page=../../../../etc/passwd', '/search?q=change+update', '/api/address', '/rest/order-history/x', '/vulnerabilities/sqli/?id=1&Submit=Submit', '/api/products?order=asc']) expect(classifyMethod('GET', u(path))).toBe('active_safe');
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

  it('fails closed on malformed or non-UTF-8 escapes and strips trailing dots and spaces', () => {
    const lab = { allowedOrigins: ['https://shop.example.com'], excludedPaths: ['/admin', '/setup.php'] };
    for (const path of ['/%61dmin/%ZZ', '/admin%20', '/admin.', '/setup.php.', '/setup%2ephp%20', '/%61dmin%20/x']) {
      expect(checkScope(`https://shop.example.com${path}`, lab), path).toEqual({ ok: false, rule: 'excluded_path' });
    }
    for (const path of ['/%61dmin%ff', '/admin%ff', '/setup%2ephp%ff', '/%c0%aeadmin', '/x/%ff%2f%2e%2e%2fadmin']) {
      expect(checkScope(`https://shop.example.com${path}`, lab), path).toEqual({ ok: false, rule: 'invalid_path' });
    }
    expect(checkScope('https://shop.example.com/caf%C3%A9/x', lab).ok).toBe(true);
    expect(checkScope('https://shop.example.com/x/%ZZ', lab).ok).toBe(true);
    expect(checkScope('https://shop.example.com/administrator.', lab).ok).toBe(true);
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

describe('setsNewPassword', () => {
  const u = (s: string): URL => new URL(s);
  it('flags a new password with a matching confirmation (query)', () => {
    expect(setsNewPassword(u('http://lab/vulnerabilities/csrf/?password_new=x1&password_conf=x1&Change=Change'), undefined)).toBe(true);
  });
  it('flags a form body with a matching confirmation', () => {
    expect(setsNewPassword(u('http://lab/vulnerabilities/captcha/'), 'step=2&password_new=x1&password_conf=x1')).toBe(true);
  });
  it('flags a new password with no confirmation (JSON)', () => {
    expect(setsNewPassword(u('http://lab/api/me'), '{"newPassword":"x1"}')).toBe(true);
  });
  it('allows a mismatched confirmation (the site refuses the change)', () => {
    expect(setsNewPassword(u('http://lab/vulnerabilities/csrf/?password_new=a1&password_conf=b2'), undefined)).toBe(false);
  });
  it('ignores ordinary password fields (sign-in forms)', () => {
    expect(setsNewPassword(u('http://lab/login.php'), 'username=admin&password=x&Login=Login')).toBe(false);
  });
});
