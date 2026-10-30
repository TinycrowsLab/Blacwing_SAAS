import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** The stable codes the secrets write API answers with beyond the generic ones (SECRETS-004). */
export type SecretApiErrorCode =
  | 'SECRET_NAME_CONFLICT'
  | 'SECRET_IN_USE'
  | 'SECRET_TOO_LARGE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_MISMATCH';

/** A refusal of the secrets API, mapped to RFC 9457 problem+json by the route scope's error handler. */
export class SecretApiError extends AppError {
  declare readonly code: SecretApiErrorCode;

  constructor(code: SecretApiErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { ...options, detail });
  }
}
