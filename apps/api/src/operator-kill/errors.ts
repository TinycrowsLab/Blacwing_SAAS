import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** The stable codes the operator kill API answers with (CONTEXT_PACK §1.2, §8.5). */
export type OperatorKillErrorCode = 'NOT_OPERATOR' | 'KILL_ALREADY_IN_PROGRESS' | 'KILL_PARTIAL';

/** A refusal or honest failure of the operator kill API, mapped to problem+json by the route's handler. */
export class OperatorKillError extends AppError {
  declare readonly code: OperatorKillErrorCode;

  constructor(code: OperatorKillErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { ...options, detail });
  }
}
