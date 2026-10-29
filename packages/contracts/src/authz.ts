import { z } from 'zod';

import {
  authorisableIntrusivenessSchema,
  runBudgetsSchema,
  standingAuthorisationStatusSchema,
  standingScopeRulesSchema,
  testWindowSchema,
} from './entities/authorisation.js';
import { LIMITS } from './limits.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';

/**
 * Standing-authorisation API contracts (AUTHZ-002, CONTEXT_PACK §7, §9). The wire shapes of the draft,
 * read, patch and submit routes under `/v1/standing-authorisations`. Bodies are strict: an unknown key
 * is refused, never ignored. The entity invariants live in `entities/authorisation.ts` and the window and
 * ceiling checks in `@blackwing/domain`, so the database, the domain and this API agree.
 */

/** Largest number of assets one standing authorisation may cover. */
export const SA_MAX_ASSETS = 100;
/** Largest number of test classes and test windows one standing authorisation may carry. */
export const SA_MAX_LIST_ITEMS = 50;

/** The fields a caller sets on a draft. Shared by create (all required) and patch (all optional). */
const saFieldsShape = {
  assetIds: z.array(uuidV7Schema).min(1).max(SA_MAX_ASSETS),
  scopeRules: standingScopeRulesSchema,
  maxIntrusiveness: authorisableIntrusivenessSchema,
  preApprovedTestClasses: z
    .array(z.string().min(1).max(LIMITS.shortTextMax))
    .max(SA_MAX_LIST_ITEMS),
  defaultBudgets: runBudgetsSchema,
  testWindows: z.array(testWindowSchema).max(SA_MAX_LIST_ITEMS),
  validFrom: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
} as const;

/** `POST /v1/standing-authorisations` body: a complete draft. */
export const createStandingAuthorisationSchema = z.strictObject(saFieldsShape);
export type CreateStandingAuthorisationInput = z.infer<typeof createStandingAuthorisationSchema>;

/**
 * `PATCH /v1/standing-authorisations/:id` body: any subset of the draft fields. An empty body changes
 * nothing, so it is refused (422) rather than answered as a silent no-op.
 */
export const patchStandingAuthorisationSchema = z
  .strictObject(saFieldsShape)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'the patch must change at least one field',
  });
export type PatchStandingAuthorisationInput = z.infer<typeof patchStandingAuthorisationSchema>;

/**
 * A standing authorisation as the API returns it. `id` is the `sa_…` public id. `signature` and
 * `signingKeyId` stay `null` until the signing step (AUTHZ-004/008); `version` is the optimistic
 * concurrency counter behind the ETag.
 */
export const standingAuthorisationDtoSchema = z.strictObject({
  id: z.string().min(1),
  assetIds: z.array(uuidV7Schema).min(1),
  scopeRules: standingScopeRulesSchema,
  maxIntrusiveness: authorisableIntrusivenessSchema,
  preApprovedTestClasses: z.array(z.string()),
  defaultBudgets: runBudgetsSchema,
  testWindows: z.array(testWindowSchema),
  validFrom: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  requesterId: uuidV7Schema,
  approverId: uuidV7Schema.nullable(),
  signature: z.string().min(1).nullable(),
  signingKeyId: z.string().min(1).nullable(),
  status: standingAuthorisationStatusSchema,
  revocationReason: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type StandingAuthorisationDto = z.infer<typeof standingAuthorisationDtoSchema>;

/**
 * `POST /v1/standing-authorisations/:id/reject` body (AUTHZ-008). A rejection needs a reason, recorded with the
 * gate decision, because it sends the draft back to its requester. Blank text is refused.
 */
export const rejectStandingAuthorisationSchema = z.strictObject({
  reason: z.string().trim().min(1).max(LIMITS.reasonMax),
});
export type RejectStandingAuthorisationInput = z.infer<typeof rejectStandingAuthorisationSchema>;

/** `GET /v1/standing-authorisations` query: a cursor page in id order (§9). `limit` is capped by the service. */
export const standingAuthorisationListQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(LIMITS.urlMax).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
export type StandingAuthorisationListQuery = z.infer<typeof standingAuthorisationListQuerySchema>;
