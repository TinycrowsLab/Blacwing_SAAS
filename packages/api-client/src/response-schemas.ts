import { z } from 'zod';

import {
  assetListResponseSchema,
  assetVerificationViewSchema,
  assetViewSchema,
  planDiffSchema,
  testCaseViewSchema,
  testPlanPageSchema,
  testPlanViewSchema,
  assessmentRequestListResponseSchema,
  assessmentRequestResponseSchema,
  preflightDryRunResponseSchema,
  auditActionSchema,
  auditOutcomeSchema,
  auditSeveritySchema,
  findingDetailSchema,
  findingListResponseSchema,
  findingTriageResponseSchema,
  gate1DecisionResponseSchema,
  gate1PlanViewSchema,
  gate1SubmitResponseSchema,
  killEventSchema,
  killTriggerResponseSchema,
  oncallRosterSchema,
  orgProfileSchema,
  planValidationResultSchema,
  signupAcceptedSchema,
  signupVerifiedSchema,
  standingAuthorisationDtoSchema,
  surfaceRunViewSchema,
  tenantSettingsResponseSchema,
  notificationChannelViewSchema,
  inputManifestSpecObjectSchema,
  inputManifestUploadGrantSchema,
  inputManifestUploadRemovedSchema,
  serviceAccountSchema,
  pageSchema,
  secretMetadataSchema,
  secretWriteResponseSchema,
} from '@blackwing/contracts';

import type { OperationId } from './generated/operations.js';

/** The kill event as `GET /v1/kill/{id}` serves it: the `id` field is named `killEventId` on the wire. */
const killEventViewSchema = z.preprocess((value: unknown) => {
  if (typeof value !== 'object' || value === null || !('killEventId' in value)) return value;
  const { killEventId, ...rest } = value;
  return { ...rest, id: killEventId };
}, killEventSchema);

/** `GET /v1/kill`: the tenant's kill history, newest first. */
const killEventListSchema = z.strictObject({ items: z.array(killEventViewSchema) });

/** One ledger row as `GET /v1/audit/events` serves it (`AuditEventView`); the other fields are not re-checked here. */
const auditEventViewSchema = z.looseObject({
  id: z.uuid(),
  seq: z.int().min(1),
  occurredAt: z.iso.datetime(),
  action: auditActionSchema,
  severity: auditSeveritySchema,
  outcome: auditOutcomeSchema,
});

/** One page of the audit ledger, newest first; `nextCursor` is absent on the last page. */
const auditEventsPageSchema = z.looseObject({
  items: z.array(auditEventViewSchema),
  nextCursor: z.string().min(1).optional(),
});

/** Bounds the API enforces on a persona override (`MAX_OVERRIDE_TURNS`, `MAX_OVERRIDE_BUDGET_USD`). */
const MAX_OVERRIDE_TURNS = 10_000;
const MAX_OVERRIDE_BUDGET_USD = 10_000;

/**
 * The persona override view `GET`/`PUT /v1/personas/{persona}/override` serve (REGISTRY-010). It mirrors the
 * OpenAPI `PersonaOverrideView` component; the bounds are the ones the API enforces (`@blackwing/agents`).
 */
const personaOverrideViewSchema = z.strictObject({
  persona: z.string(),
  override: z
    .strictObject({
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      maxTurns: z.number().int().min(1).max(MAX_OVERRIDE_TURNS).optional(),
      maxBudgetUsd: z.number().positive().max(MAX_OVERRIDE_BUDGET_USD).optional(),
      lowerStandardTier: z.boolean().optional(),
    })
    .nullable(),
  updatedAt: z.string().nullable(),
});

/**
 * The persona registry view `GET /v1/personas/{persona}` serves (REGISTRY-011). It mirrors the OpenAPI
 * `PersonaRegistryView` component; the list wraps it in `items`.
 */
const personaRegistryViewSchema = z.strictObject({
  name: z.string(),
  mandate: z.string(),
  promptVersion: z.string(),
  tierAlias: z.enum(['deep', 'standard', 'fast']),
  effective: z.strictObject({
    model: z.string(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    maxTurns: z.number().int(),
    maxBudgetUsd: z.number(),
  }),
  overridden: z.array(z.string()),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  declaredOracleTypes: z.array(z.string()),
  inputs: z.array(z.string()),
  intrusivenessCeiling: z.string(),
  requiresSubmission: z.boolean(),
  helpers: z.array(
    z.strictObject({
      name: z.string(),
      description: z.string(),
      tierAlias: z.enum(['deep', 'standard', 'fast']),
      allowedTools: z.array(z.string()),
    }),
  ),
});

const personaRegistryListSchema = z.strictObject({ items: z.array(personaRegistryViewSchema) });

/** One cursor page of standing authorisations (`Page<StandingAuthorisationDto>`, AUTHZ-002). */
const standingAuthorisationPageSchema = z.strictObject({
  items: z.array(standingAuthorisationDtoSchema),
  nextCursor: z.string().min(1).nullable(),
  hasMore: z.boolean(),
});

/** The on-call rosters page (`GET /v1/oncall/rosters`): every roster of the tenant, no cursor yet. */
const oncallRosterPageSchema = z.strictObject({
  items: z.array(oncallRosterSchema),
  nextCursor: z.null(),
});

/**
 * Zod schema per successful status of every operation (non-prod response validation). The record is
 * keyed by every `OperationId`, so an operation added to the spec fails to compile until it is mapped.
 */
const quotaCountSchema = z.strictObject({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
});

export const RESPONSE_SCHEMAS: Readonly<
  Record<OperationId, Readonly<Partial<Record<number, z.ZodType>>>>
> = {
  getKillEvent: { 200: killEventViewSchema },
  listKillEvents: { 200: killEventListSchema },
  listAuditEvents: { 200: auditEventsPageSchema },
  // text/event-stream, not JSON: there is no body schema to check, so the client returns it unparsed.
  streamRunEvents: {},
  requestSignup: { 202: signupAcceptedSchema },
  triggerKill: { 202: killTriggerResponseSchema },
  getPersonaOverride: { 200: personaOverrideViewSchema },
  putPersonaOverride: { 200: personaOverrideViewSchema },
  verifySignup: { 200: signupVerifiedSchema },
  listPersonas: { 200: personaRegistryListSchema },
  getPersona: { 200: personaRegistryViewSchema },
  getTenantSettings: { 200: tenantSettingsResponseSchema },
  listNotificationChannels: {
    200: z.object({ items: z.array(notificationChannelViewSchema) }).strict(),
  },
  createNotificationChannel: { 201: notificationChannelViewSchema },
  getNotificationChannel: { 200: notificationChannelViewSchema },
  updateNotificationChannel: { 200: notificationChannelViewSchema },
  deleteNotificationChannel: { 200: notificationChannelViewSchema },
  getCurrentTenant: { 200: orgProfileSchema },
  // Plan quotas (TENANT-009): used against limit per resource; `limit: null` is unlimited.
  getTenantQuotas: {
    200: z.object({
      plan: z.enum(['free', 'pro', 'enterprise']),
      assets: quotaCountSchema,
      concurrentRuns: quotaCountSchema,
      members: quotaCountSchema,
      monthlyCostUsd: z.object({
        used: z.number().nonnegative(),
        limit: z.number().nonnegative().nullable(),
        periodStart: z.string(),
        periodEnd: z.string(),
      }),
    }),
  },
  updateCurrentTenant: { 200: orgProfileSchema },
  listServiceAccounts: {
    200: z
      .object({ items: z.array(serviceAccountSchema), nextCursor: z.string().nullable() })
      .strict(),
  },
  createServiceAccount: { 201: serviceAccountSchema },
  getServiceAccount: { 200: serviceAccountSchema },
  updateServiceAccount: { 200: serviceAccountSchema },
  disableServiceAccount: { 200: serviceAccountSchema },
  createInputManifestUpload: { 201: inputManifestUploadGrantSchema },
  completeInputManifestUpload: { 200: inputManifestSpecObjectSchema },
  deleteInputManifestUpload: { 200: inputManifestUploadRemovedSchema },
  getGate1Plan: { 200: gate1PlanViewSchema },
  getRunSurface: { 200: surfaceRunViewSchema },
  submitGate1: { 200: gate1SubmitResponseSchema },
  decideGate1: { 200: gate1DecisionResponseSchema },
  updateTenantSettings: { 200: tenantSettingsResponseSchema },
  listAssessmentRequests: { 200: assessmentRequestListResponseSchema },
  createAssessmentRequest: { 201: assessmentRequestResponseSchema },
  getAssessmentRequest: { 200: assessmentRequestResponseSchema },
  updateAssessmentRequest: { 200: assessmentRequestResponseSchema },
  submitAssessmentRequest: { 200: assessmentRequestResponseSchema },
  withdrawAssessmentRequest: { 200: assessmentRequestResponseSchema },
  dryRunAssessmentRequestPreflight: { 200: preflightDryRunResponseSchema },
  createStandingAuthorisation: { 201: standingAuthorisationDtoSchema },
  listStandingAuthorisations: { 200: standingAuthorisationPageSchema },
  getStandingAuthorisation: { 200: standingAuthorisationDtoSchema },
  updateStandingAuthorisation: { 200: standingAuthorisationDtoSchema },
  submitStandingAuthorisation: { 200: standingAuthorisationDtoSchema },
  approveStandingAuthorisation: { 200: standingAuthorisationDtoSchema },
  rejectStandingAuthorisation: { 200: standingAuthorisationDtoSchema },
  createTestPlanVersion: { 201: testPlanViewSchema },
  listTestPlanVersions: { 200: testPlanPageSchema },
  getTestPlanVersion: { 200: testPlanViewSchema },
  diffTestPlanVersions: { 200: planDiffSchema },
  addTestCase: { 201: testCaseViewSchema },
  updateTestCase: { 200: testCaseViewSchema },
  removeTestCase: { 200: testCaseViewSchema },
  listAssets: { 200: assetListResponseSchema },
  createAsset: { 200: assetViewSchema, 201: assetViewSchema },
  getAsset: { 200: assetViewSchema },
  updateAsset: { 200: assetViewSchema },
  deleteAsset: { 200: assetViewSchema },
  getAssetVerification: { 200: assetVerificationViewSchema },
  startAssetVerification: { 201: assetVerificationViewSchema },
  checkAssetVerification: { 200: assetVerificationViewSchema },
  cancelAssetVerification: { 200: assetVerificationViewSchema },
  validateTestPlan: { 200: planValidationResultSchema },
  listOncallRosters: { 200: oncallRosterPageSchema },
  createOncallRoster: { 201: oncallRosterSchema },
  getOncallRoster: { 200: oncallRosterSchema },
  updateOncallRoster: { 200: oncallRosterSchema },
  listFindings: { 200: findingListResponseSchema },
  getFinding: { 200: findingDetailSchema },
  releaseFinding: { 200: findingTriageResponseSchema },
  rejectFinding: { 200: findingTriageResponseSchema },
  markFindingDuplicate: { 200: findingTriageResponseSchema },
  acceptFindingRisk: { 200: findingTriageResponseSchema },
  listSecrets: { 200: pageSchema(secretMetadataSchema) },
  createSecret: { 201: secretWriteResponseSchema },
  getSecret: { 200: secretMetadataSchema },
  updateSecret: { 200: secretWriteResponseSchema },
  deleteSecret: { 200: secretMetadataSchema },
};
