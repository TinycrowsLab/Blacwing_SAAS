import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { pageSchema } from '../pagination.js';
import { cweIdSchema, isoDateTimeSchema, sha256HexSchema, uuidV7Schema } from '../primitives.js';
import {
  acceptedRiskSchema,
  baselineStatusSchema,
  cvssSeverityBandSchema,
  findingClassificationSchema,
  findingLocationSchema,
  findingStatusSchema,
  mappingVersionSchema,
  severitySchema,
} from './finding.js';
import { evidenceChainRefSchema } from '../validation/evidence.js';

/**
 * Wire contracts of the finding query API (FINDING query, CONTEXT_PACK §9). Read-only: triage transitions belong
 * to TRIAGE. Every response is validated against these schemas before it leaves the API. The tenant is never a
 * query parameter: it comes from the authenticated caller.
 */

/** Public id of a finding (`fnd_…`). */
export const findingPublicIdSchema = z.string().regex(/^fnd_[A-Za-z0-9]+$/);

/** An OWASP Top 10 2021 category as stored on a finding (`A01`..`A10`). */
const owaspCategorySchema = z.string().regex(/^A(0[1-9]|10)$/, 'must look like A01..A10');

/**
 * Filters of `GET /v1/findings`. Unknown keys are refused. `cwe` and `owasp` are also checked against the pinned id
 * lists by the service (an id that does not exist is a `400 invalid_filter`, not an empty page).
 */
export const findingListFiltersSchema = z.strictObject({
  assetId: uuidV7Schema.optional(),
  status: findingStatusSchema.optional(),
  severity: cvssSeverityBandSchema.optional(),
  cwe: cweIdSchema.optional(),
  owasp: owaspCategorySchema.optional(),
  baselineStatus: baselineStatusSchema.optional(),
});
export type FindingListFilters = z.infer<typeof findingListFiltersSchema>;

/** Page size of the finding list when the client sends no `limit`, and the largest one (§9). */
export const FINDING_LIST_LIMIT_DEFAULT = 50;
export const FINDING_LIST_LIMIT_MAX = 200;

/** Occurrences and evidence refs inlined on one finding; the rest are counted and flagged `truncated` (§9). */
export const FINDING_DETAIL_INLINE_MAX = 50;

/** One finding in a list: the summary the dashboard and the finding list render. */
export const findingSummarySchema = z.strictObject({
  id: findingPublicIdSchema,
  title: z.string().min(1).max(LIMITS.labelMax),
  class: z.string().min(1).max(LIMITS.shortTextMax),
  status: findingStatusSchema,
  baselineStatus: baselineStatusSchema.nullable(),
  severity: severitySchema.nullable(),
  cweId: cweIdSchema.nullable(),
  owaspCategory: z.string().min(1).max(LIMITS.shortTextMax).nullable(),
  unmapped: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  assetId: uuidV7Schema,
  location: findingLocationSchema,
  firstSeenRunId: uuidV7Schema,
  lastSeenRunId: uuidV7Schema,
  stateVersion: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type FindingSummary = z.infer<typeof findingSummarySchema>;

/** A page of findings (`items`, `nextCursor`, `hasMore`, §9). */
export const findingListResponseSchema = pageSchema(findingSummarySchema);
export type FindingListResponse = z.infer<typeof findingListResponseSchema>;

/** One run's sighting of a finding. */
export const findingOccurrenceSchema = z.strictObject({
  id: uuidV7Schema,
  runId: uuidV7Schema,
  occurrenceStatus: z.string().min(1).max(LIMITS.shortTextMax),
  evidenceChainHead: sha256HexSchema.nullable(),
  detectedAt: isoDateTimeSchema,
});
export type FindingOccurrence = z.infer<typeof findingOccurrenceSchema>;

/**
 * One bound evidence reference of an occurrence, in chain order (EVIDENCE): the evidence id, its object key, its
 * SHA-256 and its chain link, plus the occurrence and run it belongs to. References only, never the bytes.
 */
export const findingEvidenceRefSchema = evidenceChainRefSchema.extend({
  occurrenceId: uuidV7Schema,
  runId: uuidV7Schema,
});
export type FindingEvidenceRef = z.infer<typeof findingEvidenceRefSchema>;

/** A bounded slice of a collection: the first `items`, the full `total`, and whether `items` is a prefix. */
function boundedSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(FINDING_DETAIL_INLINE_MAX),
    total: z.number().int().min(0),
    truncated: z.boolean(),
  });
}

/**
 * One finding with its detail projection (FINDING-004 occurrences, FINDING-005 severity, FINDING-006 mapping,
 * FINDING-007 confidence and baseline, EVIDENCE refs). `mapping` is the classifier's output; `acceptedRisk` is set
 * exactly for an accepted-risk finding.
 */
export const findingDetailSchema = findingSummarySchema.extend({
  mappingVersion: mappingVersionSchema.nullable(),
  classification: findingClassificationSchema.nullable(),
  acceptedRisk: acceptedRiskSchema.nullable(),
  releasedBy: uuidV7Schema.nullable(),
  releasedAt: isoDateTimeSchema.nullable(),
  occurrences: boundedSchema(findingOccurrenceSchema),
  evidence: boundedSchema(findingEvidenceRefSchema),
});
export type FindingDetail = z.infer<typeof findingDetailSchema>;
