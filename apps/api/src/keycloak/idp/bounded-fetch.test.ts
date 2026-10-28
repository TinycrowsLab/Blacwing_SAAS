import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import { type FetchLike, fetchBoundedText, requirePublicHttpsUrl } from './bounded-fetch.js';

const KIB = 1024;
const CAP_BYTES = KIB;

describe('requirePublicHttpsUrl (SSRF guard, CWE-918)', () => {
  it.each([
    'https://idp.example.test/sso',
    'https://login.example.test:8443/path?q=1',
    'https://8.8.8.8/metadata',
  ])('accepts a public https URL: %s', (value) => {
    expect(requirePublicHttpsUrl(value, 'The URL').protocol).toBe('https:');
  });

  it.each([
    ['plain http', 'http://idp.example.test/sso'],
    ['a file URL', 'file:///etc/passwd'],
    ['credentials in the URL', 'https://user:pass@idp.example.test/'],
    ['a fragment', 'https://idp.example.test/#frag'],
    ['localhost', 'https://localhost/sso'],
    ['a *.localhost name', 'https://idp.localhost/sso'],
    ['the loopback address', 'https://127.0.0.1/sso'],
    ['a private 10/8 address', 'https://10.1.2.3/sso'],
    ['a private 192.168/16 address', 'https://192.168.0.5/sso'],
    ['a private 172.16/12 address', 'https://172.20.0.1/sso'],
    ['the link-local metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['the carrier-grade NAT range', 'https://100.64.1.1/sso'],
    ['an unspecified 0.0.0.0 address', 'https://0.0.0.0/sso'],
    ['the IPv6 loopback', 'https://[::1]/sso'],
    ['an IPv6 unique-local address', 'https://[fd00::1]/sso'],
    ['an IPv6 link-local address', 'https://[fe80::1]/sso'],
    ['an IPv4-mapped private address', 'https://[::ffff:10.0.0.1]/sso'],
    ['not a URL', 'not a url'],
  ])('refuses %s', (_name, value) => {
    expect(() => requirePublicHttpsUrl(value, 'The URL')).toThrow(ValidationError);
  });
});

const respond =
  (response: Response): FetchLike =>
  () =>
    Promise.resolve(response);

const fail =
  (cause: Error): FetchLike =>
  () =>
    Promise.reject(cause);

const options = (fetchImpl: FetchLike, maxBytes = CAP_BYTES) => ({
  fetch: fetchImpl,
  url: 'https://idp.example.test/doc',
  accept: 'application/json',
  maxBytes,
  timeoutMs: 1000,
});

describe('fetchBoundedText', () => {
  it('returns the body of a 200 answer and sends no redirects', async () => {
    let init: RequestInit | undefined;
    const text = await fetchBoundedText({
      ...options((_url, requestInit) => {
        init = requestInit;
        return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
      }),
    });
    expect(text).toBe('{"ok":true}');
    expect(init?.redirect).toBe('manual');
  });

  it('maps a network failure to a retryable EXTERNAL_BACKEND_UNAVAILABLE', async () => {
    const error = await fetchBoundedText(options(fail(new TypeError('fetch failed')))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'EXTERNAL_BACKEND_UNAVAILABLE',
      retryable: true,
      httpStatus: 503,
    });
  });

  it.each([429, 500, 503])('maps a %i answer to a retryable unavailable error', async (status) => {
    const error = await fetchBoundedText(options(respond(new Response('', { status })))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'EXTERNAL_BACKEND_UNAVAILABLE', retryable: true });
  });

  it('treats a redirect as a configuration error, not followed', async () => {
    const redirect = new Response('', {
      status: 302,
      headers: { location: 'https://evil.example.test/' },
    });
    const error = await fetchBoundedText(options(respond(redirect))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as ValidationError).detail)).toMatch(/redirects are not followed/);
  });

  it('refuses a document whose declared length is over the cap, without reading it', async () => {
    const declared = new Response('x', { status: 200, headers: { 'content-length': '999999' } });
    const error = await fetchBoundedText(options(respond(declared))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses a streamed body over the cap', async () => {
    const big = new Response('a'.repeat(2 * KIB), { status: 200 });
    const error = await fetchBoundedText(options(respond(big))).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('returns an empty string for an empty body', async () => {
    await expect(
      fetchBoundedText(options(respond(new Response(null, { status: 200 })))),
    ).resolves.toBe('');
  });
});
