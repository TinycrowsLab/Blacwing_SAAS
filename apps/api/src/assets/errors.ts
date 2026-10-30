import { AppError, type AppErrorOptions } from '@blackwing/errors';

/**
 * Asset API errors (ASSET-002, #355). Each carries a registry code, so the problem+json filter answers
 * the status and the stable `code` without any mapping table here.
 */

/** `ASSET_STALE_WRITE` (409): the `If-Match` ETag no longer matches the asset (optimistic concurrency). */
export class AssetStaleWriteError extends AppError {
  declare readonly code: 'ASSET_STALE_WRITE';
  constructor(options: AppErrorOptions = {}) {
    super('ASSET_STALE_WRITE', 'asset was modified concurrently', {
      detail: 'The asset was modified; re-fetch it and retry with the current ETag.',
      ...options,
    });
  }
}

/** `ASSET_IN_USE` (409): the asset is referenced by an active standing authorisation or run. */
export class AssetInUseError extends AppError {
  declare readonly code: 'ASSET_IN_USE';
  constructor(options: AppErrorOptions = {}) {
    super('ASSET_IN_USE', 'asset is referenced by an active authorisation or run', {
      detail:
        'The asset is referenced by an active standing authorisation or run and cannot be deleted.',
      ...options,
    });
  }
}

/**
 * `ASSET_INVALID_IDENTIFIER` (422): an identifier does not normalise for its asset type. The detail names
 * the position and the rule, never the value, so a rejected credential-bearing URL is not echoed back.
 */
export class AssetInvalidIdentifierError extends AppError {
  declare readonly code: 'ASSET_INVALID_IDENTIFIER';
  constructor(index: number, reason: string, options: AppErrorOptions = {}) {
    super('ASSET_INVALID_IDENTIFIER', 'asset identifier is invalid', {
      detail: `identifiers[${String(index)}]: ${reason}.`,
      ...options,
    });
  }
}

/**
 * `ASSET_VERIFICATION_PROBE_UNAVAILABLE` (503): no probe is deployed for the challenge's method. The challenge is
 * not spent (no attempt is counted) and the asset stays unverified: fail closed until ASSET-005/006 deploy one.
 */
export class AssetVerificationProbeUnavailableError extends AppError {
  declare readonly code: 'ASSET_VERIFICATION_PROBE_UNAVAILABLE';
  constructor(method: string, options: AppErrorOptions = {}) {
    super('ASSET_VERIFICATION_PROBE_UNAVAILABLE', 'verification probe unavailable', {
      detail: `No probe is deployed for ${method} verification, so the challenge cannot be checked.`,
      ...options,
    });
  }
}

/**
 * `ASSET_VERIFICATION_METHOD_NOT_APPLICABLE` (422): the method cannot prove control of this asset type. The HTTP-file
 * method reads `https://<host>/.well-known/…`, so only `web_app` and `api` assets may use it (ASSET-006).
 */
export class AssetVerificationMethodNotApplicableError extends AppError {
  declare readonly code: 'ASSET_VERIFICATION_METHOD_NOT_APPLICABLE';
  constructor(method: string, assetType: string, options: AppErrorOptions = {}) {
    super('ASSET_VERIFICATION_METHOD_NOT_APPLICABLE', 'verification method not applicable', {
      detail: `${method} verification does not apply to a ${assetType} asset.`,
      ...options,
    });
  }
}
