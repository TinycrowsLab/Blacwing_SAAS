import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  cweIdSchema,
  isoDateTimeSchema,
  labelSchema,
  sha256HexSchema,
  uuidV7Schema,
} from '../primitives.js';
import { cvssSeverityBandSchema, findingLocationSchema } from './finding.js';
import { runModeSchema } from './run.js';
import { evidenceChainRefSchema } from '../validation/evidence.js';

/**
 * The report model (REPORT-001, CONTEXT_PACK §3.2, §8.9). `ReportModel` is the only thing an export renders from:
 * PDF, JSON and SARIF read the same fields, so the formats cannot diverge. Assembly lives in `@blackwing/reporting`.
 */

/** Version of the `ReportModel` shape. Bumped on any breaking change to a renderer-visible field. */
export const REPORT_SCHEMA_VERSION = 1;

const PROVENANCE_TEXT_MAX = 200;
const PROVENANCE_MODEL_IDS_MAX = 50;
const PROVENANCE_PERSONAS_MAX = 64;
const PROVENANCE_TOOLS_MAX = 128;
const REPORT_EVIDENCE_REFS_MAX = 64;

/** Upper bounds that keep a report memory-bounded (edge case: very large finding sets are paged, not loaded whole). */
export const REPORT_MAX_TEST_CASES = 10_000;
const REPORT_MAX_ASSETS = 200;
const REPORT_MAX_ASVS_REFS = 32;

/** Pinned versions of one run (§8.9). Every field is required: a run that did not record one cannot be exported. */
const reportProvenanceSchema = z.strictObject({
  modelIds: z
    .array(z.string().min(1).max(PROVENANCE_TEXT_MAX))
    .min(1)
    .max(PROVENANCE_MODEL_IDS_MAX),
  personaVersions: z
    .array(
      z.strictObject({
        persona: z.string().min(1).max(LIMITS.keyMax),
        version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, 'must be semver'),
        promptSha256: sha256HexSchema,
      }),
    )
    .min(1)
    .max(PROVENANCE_PERSONAS_MAX),
  sdkVersion: z.string().min(1).max(LIMITS.keyMax),
  claudeCodeVersion: z.string().min(1).max(LIMITS.keyMax),
  sandboxImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 image digest'),
  toolVersions: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(LIMITS.keyMax),
        version: z.string().min(1).max(LIMITS.keyMax),
      }),
    )
    .max(PROVENANCE_TOOLS_MAX),
  nucleiTemplateCommit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a git commit sha'),
  policyHash: sha256HexSchema,
  envelopeHash: sha256HexSchema,
  priceTableVersion: z.string().min(1).max(LIMITS.keyMax),
});

/**
 * The run manifest stored on the run (`runs.manifest`): the fields the report reads that the `runs` identity row does
 * not carry. ORCH writes it when the run is pinned; assembly refuses a run whose manifest is missing or incomplete.
 */
export const runManifestSchema = z.strictObject({
  mode: runModeSchema,
  objective: z.string().min(1).max(LIMITS.objectiveMax),
  window: z.strictObject({ start: isoDateTimeSchema, end: isoDateTimeSchema }).nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  assetSummaries: z
    .array(z.strictObject({ assetId: uuidV7Schema, label: labelSchema }))
    .max(REPORT_MAX_ASSETS),
  provenance: reportProvenanceSchema,
});
export type RunManifest = z.infer<typeof runManifestSchema>;

/** One test case's coverage entry in the finalised manifest. A not-tested case must say why. */
export const coverageEntrySchema = z
  .strictObject({
    testCaseRef: z.string().min(1).max(LIMITS.keyMax),
    status: z.enum(['tested', 'not_tested']),
    reason: z.string().min(1).max(LIMITS.shortTextMax).nullable(),
  })
  .refine((entry) => (entry.status === 'not_tested') === (entry.reason !== null), {
    message: 'a not-tested entry needs a reason, and only that entry has one',
  });
export type CoverageEntry = z.infer<typeof coverageEntrySchema>;

/** Coverage summary embedded in the report (F19): counts, and the not-tested reasons with their counts. */
const coverageSummarySchema = z.strictObject({
  finalisedAt: isoDateTimeSchema,
  totalTestCases: z.number().int().min(0).max(REPORT_MAX_TEST_CASES),
  tested: z.number().int().min(0),
  notTested: z.number().int().min(0),
  notTestedReasons: z.record(z.string(), z.number().int().positive()),
});
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;

/** Severity as the report shows it: the CVSS v4.0 vector and score, and the legacy 3.1 vector when one was stored. */
const reportSeveritySchema = z.strictObject({
  cvss4Vector: z.string().regex(/^CVSS:4\.0\/\S+$/),
  score: z.number().min(0).max(LIMITS.cvssScoreMax),
  band: cvssSeverityBandSchema,
  cvss31Vector: z
    .string()
    .regex(/^CVSS:3\.1\/\S+$/)
    .nullable(),
});

/**
 * One released finding. The narrative fields (`description`, `impact`, `evidenceNarrative`, `severityRationale`,
 * `asvsRefs`) are the reporter's `finding-report.v1` write-up, persisted on the finding. Each is null until the
 * write-up exists; `narrativePending` says so. They are prose and standard ids only: no payloads, no walkthroughs.
 */
export const reportFindingSchema = z.strictObject({
  publicId: z.string().regex(/^fnd_/),
  title: labelSchema,
  class: z.string().min(1).max(LIMITS.shortTextMax),
  cweId: cweIdSchema.nullable(),
  owaspCategory: z.string().min(1).max(LIMITS.shortTextMax).nullable(),
  asvsRefs: z
    .array(z.string().min(1).max(LIMITS.shortTextMax))
    .max(REPORT_MAX_ASVS_REFS)
    .nullable(),
  severity: reportSeveritySchema.nullable(),
  severityRationale: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  location: findingLocationSchema,
  baselineStatus: z.enum(['new', 'open', 'fixed', 'returned', 'not_retested']).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  description: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  impact: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  evidenceNarrative: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  narrativePending: z.boolean(),
  evidenceRefs: z.array(evidenceChainRefSchema).max(REPORT_EVIDENCE_REFS_MAX),
  /** The standalone repro artifact (REPRO). Null until REPRO assigns one; `reproMissing` flags it for renderers. */
  reproArtifactRef: z.string().min(1).max(LIMITS.urlMax).nullable(),
  reproMissing: z.boolean(),
  remediationSummary: z.string().min(1).max(LIMITS.reasonMax).nullable(),
});
export type ReportFinding = z.infer<typeof reportFindingSchema>;

/** An accepted-risk finding. Listed in its own labelled section, never among the active findings. */
const reportAcceptedRiskSchema = z.strictObject({
  publicId: z.string().regex(/^fnd_/),
  title: labelSchema,
  class: z.string().min(1).max(LIMITS.shortTextMax),
  reason: z.string().min(1).max(LIMITS.reasonMax),
  expiresAt: isoDateTimeSchema,
});
export type ReportAcceptedRisk = z.infer<typeof reportAcceptedRiskSchema>;

/** The whole report for one run, as of `generatedAt`. */
export const reportModelSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  generatedAt: isoDateTimeSchema,
  run: z.strictObject({
    publicId: z.string().regex(/^run_/),
    mode: runModeSchema,
    objective: z.string().min(1).max(LIMITS.objectiveMax),
    assetSummaries: z
      .array(z.strictObject({ assetId: uuidV7Schema, label: labelSchema }))
      .max(REPORT_MAX_ASSETS),
    window: z.strictObject({ start: isoDateTimeSchema, end: isoDateTimeSchema }).nullable(),
    startedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
  }),
  provenance: reportProvenanceSchema,
  /** Set when no finding was released, so the empty list is stated rather than silent. */
  noReleasedFindingsNote: z.string().min(1).max(LIMITS.reasonMax).nullable(),
  findings: z.array(reportFindingSchema),
  acceptedRisks: z.array(reportAcceptedRiskSchema),
  coverage: coverageSummarySchema,
});
export type ReportModel = z.infer<typeof reportModelSchema>;
