import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { scopeRulesSchema } from '../scope.js';
import { assessmentRequestStatusSchema } from './assessment-request.js';
import { authorisableIntrusivenessSchema, runBudgetsSchema } from './authorisation.js';
import { runModeSchema, runTriggerSchema } from './run.js';

/**
 * Wire contracts of the assessment-request API (SCOPE-005, CONTEXT_PACK §9). The create and patch bodies are
 * strict: an unknown key is a `400`, never silently dropped. The tenant and the requester are never accepted
 * from the body; both come from the authenticated caller.
 */

/** Caps on the asset list of one request: Zod array cap (`400`), before any database work. */
export const ASSESSMENT_REQUEST_ASSETS_MAX = 100;

/** Public id of an assessment request (`areq_…`). */
export const assessmentRequestPublicIdSchema = z.string().regex(/^areq_[A-Za-z0-9]+$/);

/** The request fields, without defaults, so a patch can tell an absent field from a defaulted one. */
const assessmentRequestFields = {
  mode: runModeSchema,
  objective: z.string().trim().min(1).max(LIMITS.objectiveMax),
  assetIds: z.array(z.uuid()).max(ASSESSMENT_REQUEST_ASSETS_MAX),
  scopeRules: scopeRulesSchema,
  maxIntrusiveness: authorisableIntrusivenessSchema,
  budgets: runBudgetsSchema.partial(),
  inputManifestId: z.uuid(),
  /** The standing authorisation the request is bound to. Required by submit, not by a draft. */
  saId: z.uuid(),
  trigger: runTriggerSchema,
};

/** `POST /v1/assessment-requests` body. Only `mode` and `objective` are required; a draft may name no asset yet. */
export const createAssessmentRequestSchema = z.strictObject({
  ...assessmentRequestFields,
  assetIds: assessmentRequestFields.assetIds.default([]),
  maxIntrusiveness: assessmentRequestFields.maxIntrusiveness.default('active_safe'),
  trigger: assessmentRequestFields.trigger.default('console'),
  scopeRules: assessmentRequestFields.scopeRules.optional(),
  budgets: assessmentRequestFields.budgets.optional(),
  inputManifestId: assessmentRequestFields.inputManifestId.optional(),
  saId: assessmentRequestFields.saId.optional(),
});
export type CreateAssessmentRequest = z.output<typeof createAssessmentRequestSchema>;

/** `PATCH /v1/assessment-requests/:id` body: every field optional, at least one required. */
export const patchAssessmentRequestSchema = z
  .strictObject(assessmentRequestFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'send at least one field to change',
  });
export type PatchAssessmentRequest = z.output<typeof patchAssessmentRequestSchema>;

/** One assessment request as the API returns it. `id` is the `areq_…` public id; `stateVersion` backs the ETag. */
export const assessmentRequestResponseSchema = z.strictObject({
  id: assessmentRequestPublicIdSchema,
  status: assessmentRequestStatusSchema,
  mode: runModeSchema,
  objective: z.string(),
  assetIds: z.array(z.uuid()),
  saId: z.uuid().nullable(),
  inputManifestId: z.uuid().nullable(),
  scopeRules: z.record(z.string(), z.unknown()),
  maxIntrusiveness: authorisableIntrusivenessSchema,
  budgets: runBudgetsSchema,
  trigger: runTriggerSchema,
  requestedBy: z.uuid(),
  stateVersion: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AssessmentRequestResponse = z.infer<typeof assessmentRequestResponseSchema>;

export const assessmentRequestListResponseSchema = z.strictObject({
  items: z.array(assessmentRequestResponseSchema),
});
export type AssessmentRequestListResponse = z.infer<typeof assessmentRequestListResponseSchema>;

/**
 * Stable codes of the submit gate (§3.2 step 1). Each failing check is reported with one of these, field-addressed,
 * and all failing checks come back together in one `422`.
 */
export type SubmitErrorCode =
  | 'NO_ASSETS'
  | 'SA_REQUIRED'
  | 'SA_NOT_ACTIVE'
  | 'SA_EXPIRED'
  | 'SA_SCOPE_MISMATCH'
  | 'ASSET_NOT_VERIFIED'
  | 'INTRUSIVENESS_EXCEEDS_SA'
  | 'INTRUSIVENESS_NOT_AUTHORISED'
  | 'SCOPE_EXCEEDS_SA'
  | 'BUDGET_EXCEEDS_SA';
