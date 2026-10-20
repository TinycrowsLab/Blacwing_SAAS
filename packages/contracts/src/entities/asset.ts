import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { checkTimestamps, timestampsShape, uuidV7Schema } from '../primitives.js';

/** `assets.type` (§7). */
export const assetTypeSchema = z.enum(['web_app', 'api', 'host', 'network_range', 'source_repo']);
export type AssetType = z.infer<typeof assetTypeSchema>;

/** `assets.environment` (§7). */
export const assetEnvironmentSchema = z.enum(['prod', 'staging', 'dev', 'test']);
export type AssetEnvironment = z.infer<typeof assetEnvironmentSchema>;

/** `assets.verification_status` (§7). Only `verified` assets may ever be targeted (§8.10). */
export const verificationStatusSchema = z.enum(['unverified', 'pending', 'verified', 'rejected']);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

/** `assets.verification_method` (§7). */
export const verificationMethodSchema = z.enum(['dns_txt', 'http_file', 'manual_letter']);
export type VerificationMethod = z.infer<typeof verificationMethodSchema>;

/**
 * A registered asset, §7 `assets`.
 *
 * `identifiers` holds the hostnames, URLs, CIDRs or repository URL the asset covers; their per-type
 * syntax and the F6 attestation belong to the asset epic, which extends this contract.
 */
export const assetSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    type: assetTypeSchema,
    identifiers: z.array(z.string().min(1).max(LIMITS.urlMax)).min(1),
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
