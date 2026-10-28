import { AppError, type AppErrorOptions } from '@blackwing/errors';

/*
 * Errors of the platform-operator authentication (#838). Each carries a stable registry code. Details stay generic:
 * nothing about which check failed reaches the caller, only the code the console acts on.
 */

/**
 * A valid credential that is not a platform-operator credential: a tenant token or tenant session at an operator
 * route, or an operator-realm account without the `platform_operator` role. Refused and audited (§1.2, §8.6).
 */
export class NotOperatorError extends AppError {
  declare readonly code: 'NOT_OPERATOR';
  constructor(options: AppErrorOptions = {}) {
    super('NOT_OPERATOR', 'credential is not a platform-operator credential', {
      detail: 'This control is limited to platform operators.',
      ...options,
    });
  }
}

/**
 * An operator credential whose session has not completed the operator second factor (`acr` is not
 * `operator_strong`, or is missing). The console starts MFA or step-up (IAM-009/010) on this code.
 */
export class OperatorMfaRequiredError extends AppError {
  declare readonly code: 'OPERATOR_MFA_REQUIRED';
  constructor(options: AppErrorOptions = {}) {
    super('OPERATOR_MFA_REQUIRED', 'operator second factor has not been completed', {
      detail: 'Operator sign-in requires a second factor. Complete multi-factor authentication.',
      ...options,
    });
  }
}
