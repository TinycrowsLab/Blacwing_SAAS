import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';

import {
  ConnectorAuthFailedError,
  ConnectorNotFoundError,
  ConnectorRateLimitedError,
  ConnectorUnknownProviderError,
  ConnectorUpstreamError,
  ConnectorValidationError,
} from './errors.js';

describe('connector error contract', () => {
  it.each([
    [new ConnectorUnknownProviderError(), 'CONNECTOR_UNKNOWN_PROVIDER', 422, false],
    [new ConnectorAuthFailedError(), 'CONNECTOR_AUTH_FAILED', 502, false],
    [new ConnectorRateLimitedError(), 'CONNECTOR_RATE_LIMITED', 429, true],
    [new ConnectorNotFoundError(), 'CONNECTOR_NOT_FOUND', 404, false],
    [new ConnectorUpstreamError(), 'CONNECTOR_UPSTREAM_ERROR', 502, true],
    [new ConnectorValidationError(), 'CONNECTOR_VALIDATION', 422, false],
  ])(
    '%# is an AppError with a stable code, status and retry default',
    (error, code, status, retryable) => {
      expect(isAppError(error)).toBe(true);
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(status);
      expect(error.retryable).toBe(retryable);
    },
  );

  it('carries the rate-limit retryAfter in whole seconds for the worker backoff', () => {
    expect(new ConnectorRateLimitedError('slow down', { retryAfter: 12.2 }).retryAfter).toBe(13);
    expect(new ConnectorRateLimitedError('slow down', { retryAfter: 0 }).retryAfter).toBe(0);
  });

  it('leaves retryAfter absent when the upstream did not say, or sent nonsense', () => {
    expect(new ConnectorRateLimitedError().retryAfter).toBeUndefined();
    expect(new ConnectorRateLimitedError('x', { retryAfter: -1 }).retryAfter).toBeUndefined();
    expect(
      new ConnectorRateLimitedError('x', { retryAfter: Number.NaN }).retryAfter,
    ).toBeUndefined();
    expect(
      new ConnectorRateLimitedError('x', { retryAfter: Number.POSITIVE_INFINITY }).retryAfter,
    ).toBeUndefined();
  });

  it('never serialises its cause or detail into JSON', () => {
    const error = new ConnectorAuthFailedError('auth', {
      detail: 'Token bwk_secret_value rejected',
      cause: new Error('upstream body with secret'),
    });
    const json = JSON.stringify(error);
    expect(json).not.toContain('bwk_secret_value');
    expect(json).not.toContain('upstream body');
  });
});
