import { describe, expect, it } from 'vitest';

import { resolveDocsLink } from './resolve-docs-link';

const base = { version: 'v1', page: 'user-guide', anchor: 'coverage' } as const;

describe('resolveDocsLink', () => {
  it('builds a versioned deep link on an https origin', () => {
    expect(resolveDocsLink({ ...base, baseUrl: 'https://docs.example.test' })).toBe(
      'https://docs.example.test/v1/user-guide#coverage',
    );
  });

  it('strips trailing slashes from the base', () => {
    expect(resolveDocsLink({ ...base, baseUrl: 'https://docs.example.test//' })).toBe(
      'https://docs.example.test/v1/user-guide#coverage',
    );
  });

  it('accepts a same-origin absolute path', () => {
    expect(resolveDocsLink({ ...base, baseUrl: '/docs/' })).toBe('/docs/v1/user-guide#coverage');
  });

  it('pins the version segment, so a new version never silently changes old links', () => {
    expect(resolveDocsLink({ ...base, version: 'v2', baseUrl: '/docs' })).toBe(
      '/docs/v2/user-guide#coverage',
    );
  });

  it.each([
    ['plain http', 'http://docs.example.test'],
    ['javascript scheme', ['java', 'script:alert(1)'].join('')],
    ['data scheme', 'data:text/html,hi'],
    ['protocol-relative', '//evil.example.test/docs'],
    ['backslash path', '/\\evil.example.test'],
    ['path with query', '/docs?x=1'],
    ['path with fragment', '/docs#x'],
    ['path with whitespace', '/docs /x'],
    ['credentials in URL', 'https://user:pass@docs.example.test'],
    ['query on https origin', 'https://docs.example.test/?x=1'],
    ['empty base', ''],
    ['relative without slash', 'docs'],
    ['not a URL', 'https://'],
  ])('returns null for %s', (_label, baseUrl) => {
    expect(resolveDocsLink({ ...base, baseUrl })).toBeNull();
  });

  it('returns null for an over-long base', () => {
    expect(resolveDocsLink({ ...base, baseUrl: `/${'a'.repeat(3000)}` })).toBeNull();
  });

  it.each([
    ['version without v', { version: '1' }],
    ['version with traversal', { version: 'v1/../x' }],
    ['page with traversal', { page: '../admin' }],
    ['page with uppercase', { page: 'User-Guide' }],
    ['anchor with script', { anchor: 'x"onload' }],
    ['anchor with double hyphen', { anchor: 'a--b' }],
    ['empty anchor', { anchor: '' }],
  ])('returns null for %s', (_label, override) => {
    expect(resolveDocsLink({ ...base, baseUrl: '/docs', ...override })).toBeNull();
  });
});
