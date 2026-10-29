import { AppError } from '@blackwing/errors';

/** `AUTHZ_NOT_DRAFT` (409): only a draft can be edited; a submitted or decided SA is changed by its own lifecycle. */
export class NotDraftError extends AppError {
  declare readonly code: 'AUTHZ_NOT_DRAFT';

  constructor() {
    super('AUTHZ_NOT_DRAFT', 'Standing authorisation is not a draft', {
      detail: 'Only a draft standing authorisation can be changed or submitted.',
    });
  }
}

/**
 * `AUTHZ_SOD_VIOLATION` (403): the approver is the requester, or lacks the approver role (§8.4). The detail never names
 * the users; the structured warning from `@blackwing/domain/sod` carries the reason.
 */
export class AuthzSodViolationError extends AppError {
  declare readonly code: 'AUTHZ_SOD_VIOLATION';

  constructor() {
    super('AUTHZ_SOD_VIOLATION', 'Separation of duties violated for the standing authorisation', {
      detail:
        'The caller may not decide on this standing authorisation (requester or missing approver role).',
    });
  }
}

/** `AUTHZ_ASSET_UNVERIFIED` (422): a submitted SA may cover only verified assets of its own tenant (§8.10). */
export class AssetUnverifiedError extends AppError {
  declare readonly code: 'AUTHZ_ASSET_UNVERIFIED';

  constructor() {
    super('AUTHZ_ASSET_UNVERIFIED', 'Standing authorisation covers an unverified asset', {
      detail:
        'Every asset of a standing authorisation must be verified for this tenant before submit.',
    });
  }
}
