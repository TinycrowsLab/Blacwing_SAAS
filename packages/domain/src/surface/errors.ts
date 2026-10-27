import { AppError } from '@blackwing/errors';

/** A surface input (URL, host, method, name) that cannot be canonicalised; no partial key is ever made. */
export class InvalidSurfaceInputError extends AppError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, { detail: message });
    this.name = 'InvalidSurfaceInputError';
  }
}

/** A `write_surface` batch over the node or edge cap (RECON-002). */
export class SurfaceBatchTooLargeError extends AppError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, { detail: message });
    this.name = 'SurfaceBatchTooLargeError';
  }
}
