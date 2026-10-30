import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { cweIdSchema, uuidV7Schema } from '../primitives.js';

/**
 * White-box (code-specialist) contracts: the source→sink lead, the code location it cites, and the
 * code-plus-runtime oracle that binds a static sink to the runtime signal proving the path executes (CODESPEC,
 * F12/F14/F26, CONTEXT_PACK §4.6 and §7).
 *
 * A lead is a static hypothesis, never proof. Only a runtime replay confirms it (§8.1, static output is a lead).
 * Every schema is strict and carries references and short prose only: no secret value, no payload, no command
 * (§8.7, §8.11). Provenance is pinned by `commitSha` (§8.9).
 */

/** Longest `pathSummary` a lead may carry, in UTF-8 bytes. Summaries are short; evidence lives in EVIDENCE. */
export const PATH_SUMMARY_MAX_BYTES = 4_096;
/** Most OWASP or WSTG references a lead may cite. */
const MAX_REFS = 16;
/** Most role hints a reachability hypothesis may carry. */
const MAX_ROLE_HINTS = 16;
/** A full git commit id (SHA-1 or SHA-256 is not accepted here: the repo pins SHA-1 ids). */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** Text is NFC-normalised before it is stored, so the same symbol or path compares equal (§8.9 provenance). */
function nfcString(max: number) {
  return z
    .string()
    .transform((value) => value.normalize('NFC'))
    .pipe(
      z
        .string()
        .min(1)
        .max(max)
        .refine((value) => !/\p{Cc}/u.test(value), 'must not contain control characters'),
    );
}

/**
 * A repo-relative path. Absolute paths and any `..` segment are refused, so a lead can never point outside the
 * mounted source tree (§7 source is mounted read-only).
 */
const repoRelativePathSchema = nfcString(LIMITS.filePathMax)
  .refine((value) => !value.startsWith('/'), 'must be repo-relative, not absolute')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'must be repo-relative, not a drive path')
  .refine((value) => !value.split('/').includes('..'), 'must not contain dot-dot segments')
  .refine((value) => !value.includes('\\'), 'must use forward slashes only');

/**
 * A `file:line` reference into the pinned source. `startLine` and `endLine` are 1-based and inclusive; the
 * range may not run backwards. `repoRef` and `commitSha` make the reference reproducible (§8.9): a missing or
 * empty value fails the parse, so provenance is always pinnable.
 */
export const CodeLocationSchema = z
  .strictObject({
    repoRef: z.string().min(1).max(LIMITS.shortTextMax),
    path: repoRelativePathSchema,
    startLine: z.int().min(1),
    endLine: z.int().min(1).optional(),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN, 'must be a full 40-character git commit id'),
    symbol: nfcString(LIMITS.shortTextMax).optional(),
  })
  .refine((location) => location.endLine === undefined || location.endLine >= location.startLine, {
    path: ['endLine'],
    message: 'endLine must not be before startLine',
  });
export type CodeLocation = z.infer<typeof CodeLocationSchema>;

/** A reachability hypothesis: where a request enters and which roles can reach it. Descriptive, never executable. */
const reachabilityHypothesisSchema = z.strictObject({
  entrypoint: nfcString(LIMITS.shortTextMax),
  roleHints: z.array(z.string().min(1).max(LIMITS.keyMax)).max(MAX_ROLE_HINTS),
});

/**
 * A source→sink lead produced by the code specialist from the surface model. `pathSummary` describes the data
 * path at functional altitude; it must never hold a payload string. Oversized summaries are rejected.
 */
export const SourceSinkLeadSchema = z.strictObject({
  id: uuidV7Schema,
  cweId: cweIdSchema,
  owaspRefs: z.array(z.string().min(1).max(LIMITS.shortTextMax)).max(MAX_REFS),
  wstgRefs: z.array(z.string().min(1).max(LIMITS.shortTextMax)).max(MAX_REFS),
  source: CodeLocationSchema,
  sink: CodeLocationSchema,
  pathSummary: nfcString(PATH_SUMMARY_MAX_BYTES).refine(
    (value) => new TextEncoder().encode(value).byteLength <= PATH_SUMMARY_MAX_BYTES,
    'pathSummary must be at most 4 KiB',
  ),
  confidence: z.number().min(0).max(1),
  reachabilityHypothesis: reachabilityHypothesisSchema,
});
export type SourceSinkLead = z.infer<typeof SourceSinkLeadSchema>;

/** The runtime signal kinds that can prove a static sink executes. Mirrors the runtime oracle catalogue. */
export const RUNTIME_OBSERVATION_KINDS = [
  'marker',
  'error_signature',
  'oob',
  'status_diff',
  'file_read',
] as const;
export const runtimeObservationKindSchema = z.enum(RUNTIME_OBSERVATION_KINDS);
export type RuntimeObservationKind = z.infer<typeof runtimeObservationKindSchema>;

/** A reference to the runtime observation: an evidence key, bounded and charset-restricted (never a blob). */
const observationRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/, 'must be an evidence reference')
  .refine((value) => !value.split('/').includes('..'), 'must not contain dot segments');

/**
 * The code-plus-runtime oracle params: the static sink plus the runtime observation that proves it executes.
 * Declared before the test runs; the VALIDATE replay spec binds it through `OracleBindingSchema`.
 */
export const CodePlusRuntimeOracleSchema = z.strictObject({
  type: z.literal('code_plus_runtime'),
  params: z.strictObject({
    sink: CodeLocationSchema,
    runtimeObservation: z.strictObject({
      kind: runtimeObservationKindSchema,
      ref: observationRefSchema,
    }),
  }),
});
export type CodePlusRuntimeOracle = z.infer<typeof CodePlusRuntimeOracleSchema>;

/**
 * Optional code evidence on a candidate submission (`submit_candidate`, MCP-009): the lead the candidate came
 * from and the location the runtime run confirmed. Both are references; no source body is embedded.
 */
export const CodeEvidenceSchema = z.strictObject({
  lead: SourceSinkLeadSchema,
  confirmedAt: CodeLocationSchema,
});
export type CodeEvidence = z.infer<typeof CodeEvidenceSchema>;
