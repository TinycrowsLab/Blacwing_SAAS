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
