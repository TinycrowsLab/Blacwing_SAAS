import { z } from 'zod';

import { assetEnvironmentSchema, assetTypeSchema, verificationStatusSchema } from './asset.js';

/**
 * Wire contracts of the asset list (ASSET-017 scoping input, CONTEXT_PACK §8.10; paging and filters from #355).
 * The list is read-only and tenant-scoped: the tenant comes from the authenticated caller, never from the query.
 * Only the fields the scoping wizard needs are returned, so no identifier, credential or attestation leaves the
 * server through the list. The full asset view is on `GET /v1/assets/{id}`.
 */

/** Largest page `GET /v1/assets` returns (§9); the default is 50. */
const LIST_LIMIT_MAX = 200;
/** Longest opaque cursor the list accepts. */
const LIST_CURSOR_MAX = 512;

/**
 * Query of `GET /v1/assets`. Strict: an unknown parameter is refused, never silently dropped. `verificationStatus`
 * is the wizard's filter (it asks for `verified` only); `type`, `environment` and the cursor page through #355.
 */
export const listAssetsQuerySchema = z.strictObject({
  /** Filter on the ownership verification state (§8.10). The scoping wizard asks for `verified` only. */
  verificationStatus: verificationStatusSchema.optional(),
  type: assetTypeSchema.optional(),
  environment: assetEnvironmentSchema.optional(),
  cursor: z.string().min(1).max(LIST_CURSOR_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
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

/**
 * One page of the list. `nextCursor` is null on the last page; `hasMore` mirrors it. Both are optional so a reader
 * written against the first version (items only) still parses the answer.
 */
export const assetListResponseSchema = z.strictObject({
  items: z.array(assetListItemSchema),
  nextCursor: z.string().min(1).nullable().optional(),
  hasMore: z.boolean().optional(),
});
export type AssetListResponse = z.output<typeof assetListResponseSchema>;
