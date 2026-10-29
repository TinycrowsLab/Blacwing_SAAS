import { describe, expect, it } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';
import { ScopeViolationError, ValidationError } from '@blackwing/errors';

import { assertLabTarget } from './lab-guard.js';

const scope = parseScopeRules({
  rules: [
    { effect: 'include', cidr: '127.0.0.1', ports: [13000] },
    { effect: 'include', host: 'juice.bw.localhost', ports: [13000] },
    { effect: 'exclude', cidr: '127.0.0.1', paths: ['/rest/admin/application-version'] },
  ],
});

describe('assertLabTarget', () => {
  it('accepts an in-scope loopback lab URL and returns its host and port', () => {
    expect(assertLabTarget('http://127.0.0.1:13000/rest/products/search?q=apple', scope)).toEqual({
      host: '127.0.0.1',
      port: 13000,
    });
  });

  it('accepts the lab hostname when it is in scope', () => {
    expect(assertLabTarget('http://juice.bw.localhost:13000/', scope)).toEqual({
      host: 'juice.bw.localhost',
      port: 13000,
    });
  });

  it('refuses a public host even when the scope would otherwise include it', () => {
    const broad = parseScopeRules({ rules: [{ effect: 'include', host: 'example.com' }] });
    expect(() => assertLabTarget('https://example.com/', broad)).toThrow(ScopeViolationError);
  });

  it('refuses a non-lab private address that is not in the lab allowlist', () => {
    const broad = parseScopeRules({ rules: [{ effect: 'include', cidr: '10.0.0.0/8' }] });
    expect(() => assertLabTarget('http://10.0.0.5:13000/', broad)).toThrow(ScopeViolationError);
  });

  it('refuses a lab host on a port the scope does not include', () => {
    expect(() => assertLabTarget('http://127.0.0.1:3001/', scope)).toThrow(ScopeViolationError);
  });

  it('refuses an excluded admin path on the lab host', () => {
    expect(() =>
      assertLabTarget('http://127.0.0.1:13000/rest/admin/application-version', scope),
    ).toThrow(ScopeViolationError);
  });

  it('refuses a non-http scheme', () => {
    expect(() => assertLabTarget('file:///etc/passwd', scope)).toThrow(ScopeViolationError);
  });

  it('refuses a URL that carries credentials', () => {
    expect(() => assertLabTarget('http://user:secret@127.0.0.1:13000/', scope)).toThrow(
      ScopeViolationError,
    );
  });

  it('refuses an empty scope (default deny)', () => {
    expect(() =>
      assertLabTarget('http://127.0.0.1:13000/', parseScopeRules({ rules: [] })),
    ).toThrow(ScopeViolationError);
  });

  it('rejects a malformed URL as a validation error, not a scope decision', () => {
    expect(() => assertLabTarget('not a url', scope)).toThrow(ValidationError);
  });
});
