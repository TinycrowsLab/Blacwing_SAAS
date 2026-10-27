import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** The stable Gate 2 codes the on-call resolver answers with (GATE2-003 requirement 5, edge cases). */
export type OncallErrorCode = 'GATE2_NO_ONCALL_CONFIGURED' | 'GATE2_NO_ELIGIBLE_APPROVER';

/**
 * A refusal to name a responder. Both codes fail toward deny (F13): GATE2-004 turns them into an
 * operator pause and, on timeout, a deny. They are never read as "allow".
 */
export class OncallError extends AppError {
  declare readonly code: OncallErrorCode;

  constructor(code: OncallErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(code, detail, { ...options, detail });
  }
}
