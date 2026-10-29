import { z } from 'zod';

import { assetEnvironmentSchema, assetTypeSchema, verificationStatusSchema } from './asset.js';

/**
 * Wire contracts of the asset list (ASSET-017 scoping input, CONTEXT_PACK §8.10). The list is read-only and
 * tenant-scoped: the tenant comes from the authenticated caller, never from the query. Only the fields the
 * scoping wizard needs are returned, so no identifier, credential or attestation leaves the server here.
 */

/** Query of `GET /v1/assets`. Strict: an unknown parameter is a `400`, never silently dropped. */
export const listAssetsQuerySchema = z.strictObject({
  /** Filter on the ownership verification state (§8.10). The scoping wizard asks for `verified` only. */
  verificationStatus: verificationStatusSchema.optional(),
});
export type ListAssetsQuery = z.output<typeof listAssetsQuerySchema>;

/** One asset of the list. `verificationStatus` is what the UI gates selection on (§8.10). */
export const assetListItemSchema = z.strictObject({
  /** The asset's UUID: the id an assessment request names in `assetIds` (SCOPE-005). */
  id: z.uuid(),
  name: z.string().min(1),
  type: assetTypeSchema,
  environment: assetEnvironmentSchema,
  verificationStatus: verificationStatusSchema,
});
export type AssetListItem = z.output<typeof assetListItemSchema>;

export const assetListResponseSchema = z.strictObject({
  items: z.array(assetListItemSchema),
});
export type AssetListResponse = z.output<typeof assetListResponseSchema>;
