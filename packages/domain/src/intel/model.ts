// Read models of the vulnerability-intelligence mirror (INTEL-001, CONTEXT_PACK §7, §8.6, §8.9). Each schema mirrors one
// table in packages/db/src/schema/intel.ts. The ingestion jobs (INTEL-002..006) parse upstream payloads with these before
// they write, so a malformed or oversized record is refused at the boundary and never stored.
//
// Two rules hold everywhere: a CVSS score is never invented (a block exists only with a vector, and its score must equal
// what that vector computes), and a missing vector is `null`, not an empty block.

import { z } from 'zod';

import {
  CPE_MATCHES_MAX_BYTES,
  CVE_DESCRIPTION_MAX_CHARS,
  cveIdSchema,
  cweIdSchema,
  ghsaIdSchema,
  INTEL_CWE_IDS_MAX,
  INTEL_JSON_MAX_BYTES,
  INTEL_LIMITS,
  intelSourceSchema,
  owaspSchemeSchema,
  SYNC_ERROR_MAX_CHARS,
  sourceSyncStatusSchema,
} from '@blackwing/contracts';

import { computeCvss31, computeCvss4 } from '../findings/cvss.js';

const CVSS_VECTOR_MAX = INTEL_LIMITS.cvssVectorChars;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OSV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]+$/;

/** A calendar date as `YYYY-MM-DD` (KEV and EPSS publish dates, with no time zone to get wrong). */
const isoDateSchema = z
  .string()
  .regex(ISO_DATE)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'must be a real date');

/** True when the JSON serialisation of `value` is at most `maxBytes` (the database enforces the same cap). */
function fitsJsonBytes(value: unknown, maxBytes: number): boolean {
  const serialised = JSON.stringify(value) as string | undefined;
  return serialised === undefined || Buffer.byteLength(serialised, 'utf8') <= maxBytes;
}

const jsonMessage = (maxBytes: number) => `must serialise to at most ${maxBytes} bytes`;

/** A jsonb field of any shape, refused when its serialisation exceeds `maxBytes`. */
const jsonField = (maxBytes: number) =>
  z.unknown().refine((value) => fitsJsonBytes(value, maxBytes), jsonMessage(maxBytes));

/**
 * A CVSS block: the vector as published, and the base score it computes. The score is recomputed from the vector with
 * the matching arithmetic and must agree, so a stored score cannot be one the source never derived.
 */
function cvssBlockSchema(compute: (vector: string) => number) {
  return z
    .strictObject({
      vector: z.string().min(1).max(CVSS_VECTOR_MAX),
      baseScore: z.number(),
    })
    .superRefine((block, ctx) => {
      let computed: number;
      try {
        computed = compute(block.vector);
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'vector is not a valid CVSS vector',
          path: ['vector'],
        });
        return;
      }
      if (computed !== block.baseScore) {
        ctx.addIssue({
          code: 'custom',
          message: 'baseScore must equal the score its vector computes',
          path: ['baseScore'],
        });
      }
    });
}

const cvss31BlockSchema = cvssBlockSchema((vector) => computeCvss31(vector).score);
const cvss40BlockSchema = cvssBlockSchema((vector) => computeCvss4(vector).score);

/**
 * One CVE record (`cve_records`). The upsert key is `cveId`. A record with no CVSS vector carries `null` blocks.
 * Only `cpeMatches` is size-capped here; the other free-text fields are capped by their own `max` below.
 */
export const cveRecordSchema = z.strictObject({
  cveId: cveIdSchema,
  published: z.date().nullable(),
  lastModified: z.date().nullable(),
  cvssV31: cvss31BlockSchema.nullable(),
  cvssV40: cvss40BlockSchema.nullable(),
  cweIds: z.array(cweIdSchema).max(INTEL_CWE_IDS_MAX),
  cpeMatches: z
    .array(z.unknown())
    .max(INTEL_LIMITS.cpeMatchEntries)
    .refine(
      (value) => fitsJsonBytes(value, CPE_MATCHES_MAX_BYTES),
      jsonMessage(CPE_MATCHES_MAX_BYTES),
    ),
  description: z.string().max(CVE_DESCRIPTION_MAX_CHARS).nullable(),
  sourceUpdated: z.date().nullable(),
});
export type CveRecord = z.infer<typeof cveRecordSchema>;

/** One CISA KEV entry (`kev_entries`): the CVE is in the in-the-wild exploitation catalogue. */
export const kevEntrySchema = z.strictObject({
  cveId: cveIdSchema,
  dateAdded: isoDateSchema,
  dueDate: isoDateSchema.nullable(),
  knownRansomware: z.boolean(),
  notes: z.string().max(SYNC_ERROR_MAX_CHARS).nullable(),
});

/** One FIRST EPSS score (`epss_scores`). Both values are probabilities in [0, 1]. */
export const epssScoreSchema = z.strictObject({
  cveId: cveIdSchema,
  epss: z.number().min(0).max(1),
  percentile: z.number().min(0).max(1),
  scoreDate: isoDateSchema,
});

/** One OSV advisory (`osv_advisories`). Package ecosystems and ranges are kept as published, never interpreted here. */
export const osvAdvisorySchema = z.strictObject({
  osvId: z.string().regex(OSV_ID_PATTERN).max(INTEL_LIMITS.osvIdChars),
  aliases: z.array(z.string().min(1).max(INTEL_LIMITS.osvAliasChars)).max(INTEL_LIMITS.osvAliases),
  ghsaId: ghsaIdSchema.nullable(),
  ecosystem: z.string().min(1).max(INTEL_LIMITS.ecosystemChars),
  package: z.string().min(1).max(INTEL_LIMITS.packageChars),
  affectedRanges: jsonField(INTEL_JSON_MAX_BYTES),
  severity: jsonField(INTEL_JSON_MAX_BYTES),
  modified: z.date().nullable(),
});

/** One CWE catalogue entry (`cwe_catalogue`). */
export const cweEntrySchema = z.strictObject({
  cweId: cweIdSchema,
  name: z.string().min(1).max(INTEL_LIMITS.cweNameChars),
  abstraction: z.string().min(1).max(INTEL_LIMITS.cweAbstractionChars),
  relationships: jsonField(INTEL_JSON_MAX_BYTES),
});

/** One OWASP category mapping (`owasp_mappings`), keyed by standard and code. */
export const owaspMappingSchema = z.strictObject({
  scheme: owaspSchemeSchema,
  code: z.string().min(1).max(INTEL_LIMITS.owaspCodeChars),
  title: z.string().min(1).max(INTEL_LIMITS.owaspTitleChars),
  cweIds: z.array(cweIdSchema).max(INTEL_CWE_IDS_MAX),
});

/** The incremental sync state of one source (`source_sync_state`). It pins the snapshot date into run manifests (§8.9). */
export const sourceSyncStateSchema = z.strictObject({
  source: intelSourceSchema,
  lastRun: z.date().nullable(),
  lastCursor: z.string().max(INTEL_LIMITS.cursorChars).nullable(),
  recordCount: z.number().int().min(0),
  status: sourceSyncStatusSchema,
  lastError: z.string().max(SYNC_ERROR_MAX_CHARS).nullable(),
});

/** The per-tenant join (`finding_intel`): what the mirror knew about a CVE linked to one of the tenant's findings. */
export const findingIntelSchema = z.strictObject({
  findingId: z.uuid(),
  cveId: cveIdSchema,
  kev: z.boolean(),
  epss: z.number().min(0).max(1).nullable(),
  addedAt: z.date(),
});
