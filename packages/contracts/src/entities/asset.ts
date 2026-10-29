import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { checkTimestamps, timestampsShape, uuidV7Schema } from '../primitives.js';

/**
 * Byte cap for the asset jsonb columns (`identifiers`, `attestation`, credential `login_recipe`). Enforced in
 * the database by a CHECK (`assets_identifiers_size_check` and the attestation and login-recipe checks, see `packages/db`) and here, so an oversized value is
 * refused at the boundary as well as by the database (asset-inventory edge case).
 */
export const ASSET_JSON_MAX_BYTES = 65_536;

/** `assets.type` (§7). A const tuple, so database enum CHECKs are typed from it. */
export const ASSET_TYPES = ['web_app', 'api', 'host', 'network_range', 'source_repo'] as const;
export const assetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof assetTypeSchema>;

/** `assets.environment` (§7). */
export const ASSET_ENVIRONMENTS = ['prod', 'staging', 'dev', 'test'] as const;
export const assetEnvironmentSchema = z.enum(ASSET_ENVIRONMENTS);
export type AssetEnvironment = z.infer<typeof assetEnvironmentSchema>;

/** `assets.verification_status` (§7). Only `verified` assets may ever be targeted (§8.10). */
export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

/** `assets.verification_method` (§7). */
export const VERIFICATION_METHODS = ['dns_txt', 'http_file', 'manual_letter'] as const;
export const verificationMethodSchema = z.enum(VERIFICATION_METHODS);
export type VerificationMethod = z.infer<typeof verificationMethodSchema>;

/** `asset_credentials.mfa_type` (§7). */
export const MFA_TYPES = ['none', 'totp', 'webauthn', 'sms', 'push'] as const;
export const mfaTypeSchema = z.enum(MFA_TYPES);
export type MfaType = z.infer<typeof mfaTypeSchema>;

/** The kind of one identifier an asset covers. Per-kind syntax checks belong to ASSET-003. */
export const ASSET_IDENTIFIER_KINDS = ['host', 'url', 'cidr', 'repo'] as const;

/**
 * One normalised identifier of an asset (§7 `assets.identifiers` element). Only the shape is checked here;
 * the normalisation and duplicate rules are the domain layer's (ASSET-003), so the database stores what it is
 * given and never re-derives it.
 */
export const assetIdentifierSchema = z.strictObject({
  kind: z.enum(ASSET_IDENTIFIER_KINDS),
  value: z.string().min(1).max(LIMITS.urlMax),
});
export type AssetIdentifier = z.infer<typeof assetIdentifierSchema>;

/** `assets.identifiers`: at least one identifier, serialised as jsonb within {@link ASSET_JSON_MAX_BYTES}. */
export const assetIdentifiersSchema = z
  .array(assetIdentifierSchema)
  .min(1)
  .refine((identifiers) => jsonByteLength(identifiers) <= ASSET_JSON_MAX_BYTES, {
    message: `identifiers must serialise to at most ${ASSET_JSON_MAX_BYTES} bytes`,
  });

/**
 * `assets.attestation` (F6): a JSON object written by the verification flow (ASSET-004), opaque to this
 * contract, limited in size. Plaintext secrets are never stored here (§8.7).
 */
export const assetAttestationSchema = z
  .record(z.string().min(1), z.unknown())
  .refine((attestation) => jsonByteLength(attestation) <= ASSET_JSON_MAX_BYTES, {
    message: `attestation must serialise to at most ${ASSET_JSON_MAX_BYTES} bytes`,
  });
export type AssetAttestation = z.infer<typeof assetAttestationSchema>;

/** UTF-8 byte length of the JSON form, the same measure the database's `octet_length(x::text)` uses. */
function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * A registered asset, §7 `assets`.
 *
 * The F6 attestation and the verification columns are written by ASSET-004 and are not part of this read
 * contract yet.
 */
export const assetSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    type: assetTypeSchema,
    identifiers: assetIdentifiersSchema,
    environment: assetEnvironmentSchema,
    ownerUserId: uuidV7Schema,
    verificationStatus: verificationStatusSchema,
    verificationMethod: verificationMethodSchema.nullable(),
    ...timestampsShape,
  })
  .superRefine((asset, ctx) => {
    checkTimestamps(asset, ctx);
    if (asset.verificationStatus === 'verified' && asset.verificationMethod === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['verificationMethod'],
        message: 'a verified asset must record how it was verified',
      });
    }
  });
export type Asset = z.infer<typeof assetSchema>;
