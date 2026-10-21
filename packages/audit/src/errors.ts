import { AppError, type AppErrorOptions } from '@blackwing/errors';

/**
 * `AUDIT_EVENT_INVALID` (422): the event handed to the audit helper failed `AuditEventSchema` (or
 * could not be redacted safely). Raised at the helper's boundary, before anything is persisted. The
 * message names the offending fields only, never their values: a rejected event may hold a secret.
 */
export class AuditEventInvalidError extends AppError {
  declare readonly code: 'AUDIT_EVENT_INVALID';
  constructor(message?: string, options?: AppErrorOptions) {
    super('AUDIT_EVENT_INVALID', message, options);
  }
}
