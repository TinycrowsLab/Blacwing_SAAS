// CVSS scoring for findings (FINDING-005, CONTEXT_PACK §6, §7, §8.8). The score, band and nomenclature are always
// derived from the stored vector: nothing here invents a number, and a stored severity that does not follow from its
// vector is refused (`CVSS_VECTOR_SCORE_MISMATCH`). The FIRST arithmetic is `@pandatix/js-cvss` (MIT, pinned; see
// docs/architecture/third-party-notices.md). This module adds the structural checks with clear messages, the bands the
// platform uses and the error set. Ranking reads the CVSS v4.0 result; the v3.1 block is for legacy references only.

import { CVSS31, CVSS40 } from '@pandatix/js-cvss';

import {
  type Cvss4Nomenclature,
  cvss4NomenclatureSchema,
  type CvssSeverityBand,
  type Severity,
} from '@blackwing/contracts';
import { AppError, ValidationError } from '@blackwing/errors';

/** Counter of severities written, labelled by CVSS v4.0 band (`finding_severity_total{severity}`). */
export const FINDING_SEVERITY_METRIC = 'finding_severity_total';
/** Span around a severity check. Its nomenclature is logged, since spans carry no attributes here. */
export const FINDING_CVSS_SPAN = 'finding.cvss';

const CVSS4_PREFIX = 'CVSS:4.0';
const CVSS31_PREFIX = 'CVSS:3.1';
/** Base metrics: a v4.0 vector without all of them is incomplete. */
const CVSS4_BASE_METRICS = [
  'AV',
  'AC',
  'AT',
  'PR',
  'UI',
  'VC',
  'VI',
  'VA',
  'SC',
  'SI',
  'SA',
] as const;
/** Every other metric the v4.0 specification defines: Threat, Environmental and Supplemental groups. */
const CVSS4_OTHER_METRICS = [
  'E',
  'CR',
  'IR',
  'AR',
  'MAV',
  'MAC',
  'MAT',
  'MPR',
  'MUI',
  'MVC',
  'MVI',
  'MVA',
  'MSC',
  'MSI',
  'MSA',
  'S',
  'AU',
  'R',
  'V',
  'RE',
  'U',
] as const;
const CVSS4_KNOWN_METRICS: ReadonlySet<string> = new Set<string>([
  ...CVSS4_BASE_METRICS,
  ...CVSS4_OTHER_METRICS,
]);

/** A vector that is not a valid CVSS vector for its version. The message names the rule, never the values. */
export class CvssVectorError extends ValidationError {
  constructor(version: '3.1' | '4.0', reason: string, options: { cause?: unknown } = {}) {
    super(`invalid CVSS v${version} vector: ${reason}`, {
      detail: `The CVSS v${version} vector is not valid: ${reason}.`,
      ...options,
    });
  }
}

/** A stored score, band or nomenclature that does not follow from its vector (`code 'CVSS_VECTOR_SCORE_MISMATCH'`). */
export class CvssVectorScoreMismatchError extends AppError {
  declare readonly code: 'CVSS_VECTOR_SCORE_MISMATCH';
  /** Which stored block disagrees with its vector. */
  readonly version: '3.1' | '4.0';

  constructor(version: '3.1' | '4.0') {
    super(
      'CVSS_VECTOR_SCORE_MISMATCH',
      `stored CVSS v${version} score, severity or nomenclature does not match its vector`,
      { detail: 'The stored severity does not match its CVSS vector.' },
    );
    this.version = version;
  }
}

/** The result of scoring a CVSS v4.0 vector. */
export interface Cvss4Result {
  readonly score: number;
  readonly severity: CvssSeverityBand;
  readonly nomenclature: Cvss4Nomenclature;
}

/** Lower bounds of the FIRST qualitative bands above `none`: medium from 4.0, high from 7.0, critical from 9.0. */
const MEDIUM_FROM = 4;
const HIGH_FROM = 7;
const CRITICAL_FROM = 9;

/** Qualitative band of a score (FIRST): 0.0 none, 0.1-3.9 low, 4.0-6.9 medium, 7.0-8.9 high, 9.0-10.0 critical. */
function bandOf(score: number): CvssSeverityBand {
  if (score === 0) return 'none';
  if (score < MEDIUM_FROM) return 'low';
  if (score < HIGH_FROM) return 'medium';
  if (score < CRITICAL_FROM) return 'high';
  return 'critical';
}

/**
 * Rejects what the scoring library would refuse only with a generic message: a missing or wrong prefix, a metric that
 * is not `NAME:VALUE`, an unknown or repeated metric, and a missing Base metric. Values and order are left to the
 * library, which enforces the specification's fixed ordering and the allowed values.
 */
function checkCvss4Structure(vector: string): void {
  const [prefix, ...metrics] = vector.split('/');
  if (prefix !== CVSS4_PREFIX) {
    throw new CvssVectorError('4.0', `the vector must start with ${CVSS4_PREFIX}`);
  }
  const seen = new Set<string>();
  for (const metric of metrics) {
    const match = /^([A-Z]+):([A-Za-z]+)$/.exec(metric);
    if (match === null) {
      throw new CvssVectorError('4.0', 'every metric must have the form NAME:VALUE');
    }
    const name = match[1] ?? '';
    if (!CVSS4_KNOWN_METRICS.has(name)) {
      throw new CvssVectorError('4.0', `unknown metric ${name}`);
    }
    if (seen.has(name)) {
      throw new CvssVectorError('4.0', `metric ${name} is defined more than once`);
    }
    seen.add(name);
  }
  const missing = CVSS4_BASE_METRICS.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new CvssVectorError('4.0', `missing mandatory Base metric ${missing.join(', ')}`);
  }
}

/** Runs a library constructor and turns its failure into the clear vector error for `version`. */
function parseWith<T>(version: '3.1' | '4.0', build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new CvssVectorError(
      version,
      `a metric value is not allowed by CVSS v${version}, or the metrics are out of the specified order`,
      { cause: error },
    );
  }
}

/**
 * Scores a CVSS v4.0 vector: the score, its band and its nomenclature (`CVSS-B`, `CVSS-BE`, `CVSS-BT` or
 * `CVSS-BTE`, by which metric groups carry a defined value). Throws `CvssVectorError` for a malformed vector.
 */
export function computeCvss4(vector: string): Cvss4Result {
  checkCvss4Structure(vector);
  const { score, nomenclature } = parseWith('4.0', () => {
    const cvss = new CVSS40(vector);
    return { score: cvss.Score(), nomenclature: cvss.Nomenclature() };
  });
  return {
    score,
    severity: bandOf(score),
    nomenclature: cvss4NomenclatureSchema.parse(nomenclature),
  };
}

/** Scores a CVSS v3.1 vector's Base score and band (legacy references only). Throws `CvssVectorError` if malformed. */
export function computeCvss31(vector: string): {
  readonly score: number;
  readonly severity: CvssSeverityBand;
} {
  if (!vector.startsWith(`${CVSS31_PREFIX}/`)) {
    throw new CvssVectorError('3.1', `the vector must start with ${CVSS31_PREFIX}/`);
  }
  const score = parseWith('3.1', () => new CVSS31(vector).BaseScore());
  return { score, severity: bandOf(score) };
}

/**
 * Refuses a severity whose stored score, band or nomenclature does not equal what its vector computes. The v3.1
 * block is checked the same way when present, though it does not decide ranking. Fail closed: nothing is recomputed
 * and stored in its place.
 */
export function assertSeverityMatchesVectors(severity: Severity): void {
  const cvss4 = computeCvss4(severity.cvss4.vector);
  if (
    severity.cvss4.score !== cvss4.score ||
    severity.cvss4.severity !== cvss4.severity ||
    severity.cvss4.nomenclature !== cvss4.nomenclature
  ) {
    throw new CvssVectorScoreMismatchError('4.0');
  }
  if (severity.cvss31 !== undefined) {
    const cvss31 = computeCvss31(severity.cvss31.vector);
    if (severity.cvss31.score !== cvss31.score || severity.cvss31.severity !== cvss31.severity) {
      throw new CvssVectorScoreMismatchError('3.1');
    }
  }
}
