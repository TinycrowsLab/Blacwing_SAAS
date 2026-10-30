import { z } from 'zod';

import { intrusivenessClassSchema } from '../intrusiveness.js';
import { LIMITS } from '../limits.js';
import { cweIdSchema, labelSchema, uuidV7Schema } from '../primitives.js';

/**
 * The coverage manifest of one run (COVERAGE-001, F19, CONTEXT_PACK §7). A manifest holds one row per test case: what
 * was tested, and for every other case why not. It is `open` while the run records and `finalised` once the report
 * depends on it; a finalised manifest never changes.
 */

/** `coverage_manifests.status` (§7). */
export const COVERAGE_MANIFEST_STATUSES = ['open', 'finalised'] as const;
export const coverageManifestStatusSchema = z.enum(COVERAGE_MANIFEST_STATUSES);
export type CoverageManifestStatus = z.infer<typeof coverageManifestStatusSchema>;

/**
 * `coverage_entries.outcome`: the test-case statuses that matter for coverage (§7), plus the budget and gate reasons
 * (§4.4). Only `executed` needs no reason.
 */
export const COVERAGE_OUTCOMES = [
  'executed',
  'skipped',
  'blocked',
  'model_declined',
  'out_of_budget',
  'gate_denied',
  'not_applicable',
  'failed',
] as const;
export const coverageOutcomeSchema = z.enum(COVERAGE_OUTCOMES);
export type CoverageOutcome = z.infer<typeof coverageOutcomeSchema>;

/** Byte cap on each opaque jsonb field of a coverage row (`targets`, `budget_used`, `pins`, `summary`). */
export const COVERAGE_JSON_MAX_BYTES = 16_384;
/** Cap on the items of each reference or list field (OWASP, WSTG, CWE, roles, targets). */
const COVERAGE_LIST_MAX = 64;

/** UTF-8 byte length of a value's JSON form, for the jsonb caps. */
function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** A jsonb value of at most `COVERAGE_JSON_MAX_BYTES` bytes. */
function cappedJsonSchema<T extends z.ZodType>(schema: T) {
  return schema.refine((value) => jsonBytes(value) <= COVERAGE_JSON_MAX_BYTES, {
    message: `must be at most ${COVERAGE_JSON_MAX_BYTES} bytes as JSON`,
  });
}

/** Free text is stored in Unicode NFC, so the same visible text always compares equal. */
const nfcText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .transform((value) => value.normalize('NFC'));

/**
 * One test case's row in a coverage manifest. `outcome` must be one of `COVERAGE_OUTCOMES`; any outcome other than
 * `executed` must say why (`reason`), and `executed` carries no reason.
 */
export const coverageManifestEntrySchema = z
  .strictObject({
    testCaseId: uuidV7Schema,
    title: labelSchema.transform((value) => value.normalize('NFC')),
    class: intrusivenessClassSchema,
    owaspRefs: z.array(z.string().min(1).max(LIMITS.shortTextMax)).max(COVERAGE_LIST_MAX),
    wstgRefs: z.array(z.string().min(1).max(LIMITS.shortTextMax)).max(COVERAGE_LIST_MAX),
    cweCandidates: z.array(cweIdSchema).max(COVERAGE_LIST_MAX),
    targets: cappedJsonSchema(
      z.array(z.string().min(1).max(LIMITS.urlMax)).min(1).max(COVERAGE_LIST_MAX),
    ),
    roles: z.array(z.string().min(1).max(LIMITS.keyMax)).max(COVERAGE_LIST_MAX),
    outcome: coverageOutcomeSchema,
    reason: nfcText(LIMITS.reasonMax).nullable(),
    subtaskId: uuidV7Schema.nullable(),
    budgetUsed: cappedJsonSchema(z.record(z.string(), z.unknown())).nullable(),
  })
  .refine((entry) => (entry.outcome === 'executed') === (entry.reason === null), {
    message: 'an executed entry has no reason; every other outcome needs one',
    path: ['reason'],
  });
export type CoverageManifestEntry = z.infer<typeof coverageManifestEntrySchema>;
