import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import {
  isKnownApiTop10,
  isKnownCwe,
  isKnownOwaspTop10,
  isKnownWstg,
} from '../testcases/standards.js';

/**
 * Pinned taxonomy of findings (FINDING-004, CONTEXT_PACK §8.9, §8.11): the CWE, OWASP Top 10 2021, API Security
 * Top 10 2023 and WSTG ids a finding may carry. Ids are curated data, never model output. Input is normalised
 * (NFKC, trimmed, upper-case, no leading zeros, no `:2021` edition suffix) and then checked against the pinned
 * lists, so a report or SARIF taxon never carries an id that does not exist.
 */

/**
 * CWE Top 25 (2025 edition) ids. Pinned here so the list can be flagged on a finding. A finding that carries one
 * of these ids is flagged in the classification; the membership is data and changes only with a new edition.
 */
export const CWE_TOP25_2025: ReadonlySet<string> = new Set([
  'CWE-79',
  'CWE-87',
  'CWE-89',
  'CWE-352',
  'CWE-862',
  'CWE-22',
  'CWE-78',
  'CWE-416',
  'CWE-125',
  'CWE-434',
  'CWE-476',
  'CWE-502',
  'CWE-190',
  'CWE-287',
  'CWE-787',
  'CWE-288',
  'CWE-94',
  'CWE-77',
  'CWE-269',
  'CWE-863',
  'CWE-798',
  'CWE-918',
  'CWE-306',
  'CWE-119',
  'CWE-200',
]);

/** Upper bound on candidate refs per class or per finding, so a dataset or request cannot grow without limit. */
const MAX_REFS = 8;

/** Canonical CWE id: `CWE-<n>` with no leading zeros, after NFKC and upper-casing. Unknown ids stay unchanged. */
export function normaliseCweId(raw: string): string {
  const compact = raw.normalize('NFKC').trim().toUpperCase();
  const match = /^CWE-0*([0-9]+)$/.exec(compact);
  return match?.[1] === undefined ? compact : `CWE-${match[1]}`;
}

/** Canonical OWASP id (`A03`, `API7`): the edition suffix (`:2021`, `:2023`) is dropped, zeros are padded. */
export function normaliseOwaspId(raw: string): string {
  const compact = raw
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/:(2021|2023)$/, '');
  const match = /^(API|A)0*([0-9]+)$/.exec(compact);
  if (match?.[1] === undefined || match[2] === undefined) return compact;
  return match[1] === 'A' ? `A${match[2].padStart(2, '0')}` : `API${match[2]}`;
}

/** Canonical WSTG id (`WSTG-INPV-05`): NFKC, trimmed, upper-case. */
export function normaliseWstgId(raw: string): string {
  return raw.normalize('NFKC').trim().toUpperCase();
}

/** True when `id` (already canonical) is in the pinned CWE list: the curated catalogue or the CWE Top 25 list. */
const isPinnedCwe = (id: string): boolean => isKnownCwe(id) || CWE_TOP25_2025.has(id);

/** A CWE ref: normalised, then checked against the pinned list. Unknown or retired ids are refused. */
export const cweRefSchema = z
  .string()
  .transform(normaliseCweId)
  .refine(isPinnedCwe, { message: 'unknown or retired CWE id' });

/** An OWASP Top 10 2021 ref (`A01`..`A10`). */
export const owaspTop10RefSchema = z
  .string()
  .transform(normaliseOwaspId)
  .refine(isKnownOwaspTop10, { message: 'unknown OWASP Top 10 category' });

/** An API Security Top 10 2023 ref (`API1`..`API10`). */
export const apiTop10RefSchema = z
  .string()
  .transform(normaliseOwaspId)
  .refine(isKnownApiTop10, { message: 'unknown API Security Top 10 category' });

/** A WSTG test ref (`WSTG-INPV-05`). */
export const wstgRefSchema = z
  .string()
  .transform(normaliseWstgId)
  .refine(isKnownWstg, { message: 'unknown WSTG test id' });

/**
 * Standard refs a specialist declares for one finding (from the test case that detected it). They take
 * precedence over the curated mapping for the finding's class. The schema is strict: nothing else is accepted.
 */
export const candidateRefsSchema = z.strictObject({
  cwe: z.array(cweRefSchema).max(MAX_REFS).optional(),
  owasp: owaspTop10RefSchema.optional(),
  apiTop10: apiTop10RefSchema.optional(),
  wstg: z.array(wstgRefSchema).max(MAX_REFS).optional(),
});
export type CandidateRefs = z.infer<typeof candidateRefsSchema>;

/**
 * Parses `value` against `schema`. A failure names the fields only: issue messages can echo the input, and a
 * taxon that does not exist is reported as such, never stored.
 */
export function parseTaxon<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}
