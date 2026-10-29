import { DEFAULT_MAPPING_DATASET, type MappingDataset } from './mappings.js';
import { candidateRefsSchema, CWE_TOP25_2025, parseTaxon } from './taxonomy.js';

import type { FindingClassification } from '@blackwing/contracts';

/**
 * Classifies a finding by its class and the standard refs its specialist declared (FINDING-004, #744).
 *
 * Precedence: the specialist's refs come first, then the curated mapping for the class. The primary CWE is the
 * first candidate and the primary OWASP category is the first category available. When either is missing the
 * finding is flagged `unmapped` for analyst review, and no id is invented. The result records the mapping version
 * that produced it (§8.9). The function is pure and synchronous, so the same input always gives the same output.
 */

/** The outcome of classifying one finding; the repository stores it on the row. */
export interface Classification {
  /** Primary CWE (`CWE-<n>`), or null when no candidate is known. */
  readonly cweId: string | null;
  /** Primary OWASP Top 10 category (`A01`..`A10`), or null when none is known. */
  readonly owaspCategory: string | null;
  /** True when `cweId` or `owaspCategory` is null: the finding needs analyst review. */
  readonly unmapped: boolean;
  /** True when the primary CWE is on the CWE Top 25 (2025) list. Derived, not stored. */
  readonly cweTop25: boolean;
  /** Version of the mapping dataset used. */
  readonly mappingVersion: string;
  /** Candidates kept for the reporter, plus the API Top 10 and WSTG refs. */
  readonly detail: FindingClassification;
}

/** Keeps the first occurrence of each value, so the specialist's order survives. */
const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * Classifies `findingClass`. `refs` is the specialist's declaration (unvalidated input): an unknown or
 * malformed ref throws `ValidationError` rather than being dropped, so a wrong id never reaches a report.
 */
export function classifyFinding(
  findingClass: string,
  refs: unknown = {},
  dataset: MappingDataset = DEFAULT_MAPPING_DATASET,
): Classification {
  const specialist = parseTaxon(candidateRefsSchema, refs, 'classification refs');
  const entry = Object.hasOwn(dataset.mappings, findingClass)
    ? dataset.mappings[findingClass]
    : undefined;

  const cweCandidates = unique([...(specialist.cwe ?? []), ...(entry?.cweCandidates ?? [])]);
  const cweId = cweCandidates[0] ?? null;
  const owaspCategory = specialist.owasp ?? entry?.owaspTop10 ?? null;

  return {
    cweId,
    owaspCategory,
    unmapped: cweId === null || owaspCategory === null,
    cweTop25: cweId !== null && CWE_TOP25_2025.has(cweId),
    mappingVersion: dataset.version,
    detail: {
      cweCandidates,
      apiTop10: specialist.apiTop10 ?? entry?.apiTop10 ?? null,
      wstg: unique([...(specialist.wstg ?? []), ...(entry?.wstg ?? [])]),
    },
  };
}
