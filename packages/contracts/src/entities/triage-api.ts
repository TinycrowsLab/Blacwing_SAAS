import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { findingSummarySchema } from './finding-api.js';

/**
 * Wire contracts of the Gate 3 triage API (TRIAGE-001, CONTEXT_PACK §9): the four decisions an analyst takes on a
 * Confirmed finding. Every body is strict: unknown fields are refused. A reason is text the analyst wrote; it is
 * stored and never executed. Whether a reason is blank, or an expiry is valid, is decided by the triage guards, not
 * here, so every refusal carries its own stable code (TRIAGE_REASON_REQUIRED, TRIAGE_RISK_EXPIRY_INVALID, ...).
 */

const reasonSchema = z.string().max(LIMITS.reasonMax);
const idSchema = z.string().min(1).max(LIMITS.shortTextMax);

/** `POST /v1/findings/{id}/release`. A release needs a reason too (every triage decision does, TRIAGE-001). */
export const releaseFindingSchema = z.strictObject({ reason: reasonSchema.optional() });

/** `POST /v1/findings/{id}/reject`: the finding is a false positive. */
export const rejectFindingSchema = z.strictObject({ reason: reasonSchema });

/** `POST /v1/findings/{id}/duplicate`: `canonicalFindingId` is the `fnd_…` id of the finding it duplicates. */
export const duplicateFindingSchema = z.strictObject({
  canonicalFindingId: idSchema,
  reason: reasonSchema.optional(),
});

/** `POST /v1/findings/{id}/accept-risk`: `expiry` is an ISO-8601 instant with an offset, in the future. */
export const acceptRiskFindingSchema = z.strictObject({
  reason: reasonSchema,
  expiry: idSchema.optional(),
});

/** The answer of every triage decision: the finding after the change. Its ETag is sent back in `If-Match`. */
export const findingTriageResponseSchema = z.strictObject({ finding: findingSummarySchema });
export type FindingTriageResponse = z.infer<typeof findingTriageResponseSchema>;
