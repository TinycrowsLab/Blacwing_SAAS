import { describe, expect, it } from 'vitest';

import { anthropicErrorBodySchema, DEFAULT_ANTHROPIC_VERSION } from '@blackwing/contracts';

import { anthropicError, errorTypeForStatus } from './anthropic-error.js';
import { forwardRequestHeaders, forwardResponseHeaders } from './headers.js';

describe('forwardRequestHeaders', () => {
  it('keeps anthropic-version, anthropic-beta and content-type', () => {
    const { headers, versionDefaulted } = forwardRequestHeaders({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'a,b',
      'content-type': 'application/json',
    });
    expect(versionDefaulted).toBe(false);
    expect(headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'a,b',
      'content-type': 'application/json',
    });
  });

  it('strips hop-by-hop headers, including names listed in Connection', () => {
    const { headers } = forwardRequestHeaders({
      connection: 'keep-alive, X-Custom-Hop',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      upgrade: 'h2c',
      trailer: 'x',
      'proxy-authorization': 'Basic abc',
      'x-custom-hop': '1',
      'x-kept': 'yes',
    });
    expect(Object.keys(headers).sort()).toEqual(
      ['accept-encoding', 'anthropic-version', 'content-type', 'x-kept'].sort(),
    );
  });

  it('drops client credentials, host, length and inbound trace headers', () => {
    const { headers } = forwardRequestHeaders({
      host: 'gateway',
      'content-length': '12',
      authorization: 'Bearer bw_vk_x',
      'x-api-key': 'bw_vk_x',
      cookie: 'a=b',
      traceparent: '00-abc',
      tracestate: 'k=v',
    });
    for (const name of [
      'host',
      'content-length',
      'authorization',
      'x-api-key',
      'cookie',
      'traceparent',
      'tracestate',
    ]) {
      expect(headers[name]).toBeUndefined();
    }
  });

  it('defaults a missing or blank anthropic-version to the pinned version', () => {
    expect(forwardRequestHeaders({})).toMatchObject({
      versionDefaulted: true,
      headers: { 'anthropic-version': DEFAULT_ANTHROPIC_VERSION },
    });
    expect(forwardRequestHeaders({ 'anthropic-version': '  ' }).versionDefaulted).toBe(true);
  });

  it('asks the upstream for identity encoding so bytes pass through undecoded', () => {
    expect(
      forwardRequestHeaders({ 'accept-encoding': 'gzip, br' }).headers['accept-encoding'],
    ).toBe('identity');
  });

  it('joins repeated header values', () => {
    expect(forwardRequestHeaders({ 'x-multi': ['a', 'b'] }).headers['x-multi']).toBe('a, b');
  });
});

describe('forwardResponseHeaders', () => {
  it('keeps provider headers and strips hop-by-hop, length, encoding and cookies', () => {
    const upstream = new Headers({
      'content-type': 'text/event-stream',
      'request-id': 'req_1',
      'retry-after': '3',
      'anthropic-ratelimit-requests-remaining': '9',
      connection: 'close, x-hop',
      'x-hop': '1',
      'keep-alive': 'timeout=5',
      'content-length': '10',
      'content-encoding': 'gzip',
      'set-cookie': 'cf=1',
    });
    expect(forwardResponseHeaders(upstream)).toEqual({
      'content-type': 'text/event-stream',
      'request-id': 'req_1',
      'retry-after': '3',
      'anthropic-ratelimit-requests-remaining': '9',
    });
  });
});

describe('Anthropic error shape', () => {
  it('builds an envelope that matches the contract', () => {
    const body = anthropicError('request_too_large', 'too big');
    expect(anthropicErrorBodySchema.parse(body)).toEqual({
      type: 'error',
      error: { type: 'request_too_large', message: 'too big' },
    });
  });

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [415, 'invalid_request_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [502, 'api_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
  ])('maps status %i to %s', (status, type) => {
    expect(errorTypeForStatus(status)).toBe(type);
  });
});
