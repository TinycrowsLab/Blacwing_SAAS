import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** `CONNECTOR_UNKNOWN_PROVIDER` (422): no connector is registered for the requested provider. */
export class ConnectorUnknownProviderError extends AppError {
  declare readonly code: 'CONNECTOR_UNKNOWN_PROVIDER';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONNECTOR_UNKNOWN_PROVIDER', message, options);
  }
}

/**
 * `CONNECTOR_AUTH_FAILED` (502): the upstream refused the resolved credential. The message never carries the
 * credential, the request URL or the upstream body.
 */
export class ConnectorAuthFailedError extends AppError {
  declare readonly code: 'CONNECTOR_AUTH_FAILED';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONNECTOR_AUTH_FAILED', message, options);
  }
}

/** Options for {@link ConnectorRateLimitedError}. */
export interface ConnectorRateLimitedErrorOptions extends AppErrorOptions {
  /** Seconds the worker should wait before retrying (from the upstream `Retry-After`). */
  readonly retryAfter?: number;
}

/**
 * `CONNECTOR_RATE_LIMITED` (429): the upstream throttled the call. Retryable; `retryAfter` (whole seconds) drives
 * the worker's backoff and is absent when the upstream did not say.
 */
export class ConnectorRateLimitedError extends AppError {
  declare readonly code: 'CONNECTOR_RATE_LIMITED';
  declare readonly retryAfter?: number;

  constructor(message?: string, options: ConnectorRateLimitedErrorOptions = {}) {
    super('CONNECTOR_RATE_LIMITED', message, options);
    const seconds = options.retryAfter;
    // Constructing an error must never throw, so a nonsensical value is dropped instead of rejected.
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0)
      this.retryAfter = Math.ceil(seconds);
  }
}

/** `CONNECTOR_NOT_FOUND` (404): the ticket does not exist upstream, or the ref does not match this connector. */
export class ConnectorNotFoundError extends AppError {
  declare readonly code: 'CONNECTOR_NOT_FOUND';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONNECTOR_NOT_FOUND', message, options);
  }
}

/** `CONNECTOR_UPSTREAM_ERROR` (502): any other upstream failure. Retryable. */
export class ConnectorUpstreamError extends AppError {
  declare readonly code: 'CONNECTOR_UPSTREAM_ERROR';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONNECTOR_UPSTREAM_ERROR', message, options);
  }
}

/** `CONNECTOR_VALIDATION` (422): a payload, patch, webhook body or registration breaks a connector rule. */
export class ConnectorValidationError extends AppError {
  declare readonly code: 'CONNECTOR_VALIDATION';
  constructor(message?: string, options?: AppErrorOptions) {
    super('CONNECTOR_VALIDATION', message, options);
  }
}
