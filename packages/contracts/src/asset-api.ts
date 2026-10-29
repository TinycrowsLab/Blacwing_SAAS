import { z } from 'zod';

import {
  ASSET_ENVIRONMENTS,
  ASSET_IDENTIFIER_KINDS,
  ASSET_TYPES,
  type AssetType,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
} from './entities/asset.js';
import { LIMITS } from './limits.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';

/**
 * The asset REST contract (ASSET-002, #355): bodies, query and the `AssetView` the API returns. The stored
 * shapes live in `entities/asset.ts`; this file only adds what the HTTP surface needs.
 */

/** Most identifiers one asset may cover. A larger set is split into assets. */
export const ASSET_IDENTIFIER_LIMIT = 50;

/** The identifier kind each asset type covers. A `host` asset carries `host` identifiers, and so on. */
export const ASSET_TYPE_IDENTIFIER_KIND: Readonly<
  Record<AssetType, (typeof ASSET_IDENTIFIER_KINDS)[number]>
> = Object.freeze({
  host: 'host',
  web_app: 'url',
  api: 'url',
  network_range: 'cidr',
  source_repo: 'repo',
});

/** One identifier as a client sends it. Normalisation (and the per-kind syntax) happens server-side. */
export const assetIdentifierInputSchema = z.strictObject({
  kind: z.enum(ASSET_IDENTIFIER_KINDS),
  value: z.string().trim().min(1).max(LIMITS.urlMax),
});
export type AssetIdentifierInput = z.infer<typeof assetIdentifierInputSchema>;

const identifierListSchema = z.array(assetIdentifierInputSchema).min(1).max(ASSET_IDENTIFIER_LIMIT);

/**
 * `POST /v1/assets` body. The tenant, the id and the verification state are never accepted: the tenant comes
 * from the validated principal and a new asset starts `unverified` (§8.10).
 */
export const createAssetBodySchema = z.strictObject({
  type: z.enum(ASSET_TYPES),
  name: z.string().trim().min(1).max(LIMITS.labelMax),
  identifiers: identifierListSchema,
  environment: z.enum(ASSET_ENVIRONMENTS),
  ownerUserId: uuidV7Schema,
});
export type CreateAssetBody = z.infer<typeof createAssetBodySchema>;

/**
 * `PATCH /v1/assets/{id}` body. `type` and the verification state are not writable here (a different
 * workflow). At least one field must be present.
 */
export const updateAssetBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(LIMITS.labelMax).optional(),
    identifiers: identifierListSchema.optional(),
    environment: z.enum(ASSET_ENVIRONMENTS).optional(),
    ownerUserId: uuidV7Schema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'at least one field must be provided',
  });
export type UpdateAssetBody = z.infer<typeof updateAssetBodySchema>;

/**
 * The asset as the API returns it. `id` is the UUID (as the scoping list), `publicId` the `asset_…` form. `etag` is the strong
 * validator to send back in `If-Match` on a PATCH. `warnings` carries non-fatal notices of the request that
 * produced the view (for example duplicate identifiers removed); it is empty on reads.
 */
export const assetViewSchema = z.strictObject({
  /** The asset's UUID: the id an assessment request names in `assetIds` (SCOPE-005), and the list item's `id`. */
  id: uuidV7Schema,
  /** The prefixed public form (`asset_…`), for links and display. Path parameters accept either form. */
  publicId: z.string().regex(/^asset_[0-9a-hjkmnp-tv-z]{26}$/),
  type: z.enum(ASSET_TYPES),
  name: z.string().min(1).max(LIMITS.labelMax),
  identifiers: z
    .array(z.strictObject({ kind: z.enum(ASSET_IDENTIFIER_KINDS), value: z.string().min(1) }))
    .min(1),
  environment: z.enum(ASSET_ENVIRONMENTS),
  ownerUserId: uuidV7Schema,
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  verificationMethod: z.enum(VERIFICATION_METHODS).nullable(),
  etag: z.string().regex(/^"v\d+"$/),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  warnings: z.array(z.string().min(1).max(LIMITS.labelMax)),
});
export type AssetView = z.infer<typeof assetViewSchema>;
