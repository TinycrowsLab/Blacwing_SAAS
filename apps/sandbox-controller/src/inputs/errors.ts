import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** 413: the staged inputs (or the checked-out source) exceed their cap. Refused before any partial mount. */
export class SbxInputTooLargeError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_INPUT_TOO_LARGE', message, { detail: message, ...options });
  }
}

/** 502: the private source repository refused the deploy token (or none was given). No partial checkout. */
export class SbxSourceAuthFailedError extends AppError {
  constructor(options: AppErrorOptions = {}) {
    super('SBX_SOURCE_AUTH_FAILED', 'source repository authentication failed', {
      detail: 'The source repository refused the configured deploy credential.',
      ...options,
    });
  }
}

/** 422: an object is missing, its size or sha256 does not match the manifest, or a name is unsafe. Fails closed. */
export class SbxInputIntegrityFailedError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_INPUT_INTEGRITY_FAILED', message, { detail: message, ...options });
  }
}

/** 422: a symlink in the checkout resolves outside `/src` (or cannot be resolved). The link is never followed. */
export class SbxSourceSymlinkEscapeError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super('SBX_SOURCE_SYMLINK_ESCAPE', message, { detail: message, ...options });
  }
}
