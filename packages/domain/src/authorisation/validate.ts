import {
  type IntrusivenessClass,
  IntrusivenessError,
  isSelectable,
  parseIntrusivenessClass,
} from '@blackwing/contracts';
import { AppError, type AppErrorOptions, ValidationError } from '@blackwing/errors';

/** `AUTHZ_INVALID_WINDOW` (422): the validity window is empty or inverted (`valid_from` is not before `expires_at`). */
export class InvalidSaWindowError extends AppError {
  declare readonly code: 'AUTHZ_INVALID_WINDOW';

  constructor(options: AppErrorOptions = {}) {
    super('AUTHZ_INVALID_WINDOW', 'Standing authorisation window is empty or inverted', {
      detail: 'valid_from must be earlier than expires_at.',
      ...options,
    });
  }
}

/** The fields of a new standing authorisation that the creation checks read. */
export interface SaDraftFields {
  readonly assetIds: readonly string[];
  /** Untrusted: parsed as an intrusiveness class, so anything but a canonical class is refused. */
  readonly maxIntrusiveness: unknown;
  readonly validFrom: Date;
  readonly expiresAt: Date;
}

/**
 * Creation checks, run before the row is written (AUTHZ-001 edge cases). They fail closed: an invalid
 * or NaN date is refused as an inverted window. The database enforces the same rules as CHECK
 * constraints, so a bypassed validator still cannot store a bad row.
 *
 * @returns the parsed `max_intrusiveness` class.
 * @throws {ValidationError} no assets (`VALIDATION_FAILED`).
 * @throws {IntrusivenessError} an unknown class (`SCOPE_INVALID_CLASS`) or `destructive` as a ceiling
 *   (`SCOPE_DESTRUCTIVE_FORBIDDEN`, §8.3).
 * @throws {InvalidSaWindowError} `valid_from` is not strictly before `expires_at` (`AUTHZ_INVALID_WINDOW`).
 */
export function assertSaDraft(fields: SaDraftFields): IntrusivenessClass {
  if (fields.assetIds.length === 0) {
    throw new ValidationError('A standing authorisation must cover at least one asset.', {
      detail: 'Choose at least one asset for this standing authorisation.',
    });
  }
  const ceiling = parseIntrusivenessClass(fields.maxIntrusiveness);
  if (!isSelectable(ceiling)) {
    throw new IntrusivenessError(
      'SCOPE_DESTRUCTIVE_FORBIDDEN',
      'The destructive class can never be a standing authorisation ceiling',
    );
  }
  if (!(fields.validFrom.getTime() < fields.expiresAt.getTime())) {
    throw new InvalidSaWindowError();
  }
  return ceiling;
}
