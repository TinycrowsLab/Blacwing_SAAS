import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import {
  assertSeverityMatchesVectors,
  computeCvss31,
  computeCvss4,
  CvssVectorError,
  CvssVectorScoreMismatchError,
} from './cvss.js';

import type { Severity } from '@blackwing/contracts';

// Golden vectors: the FIRST CVSS v4.0 specification examples and the reference cases the scoring library pins
// (its test suite follows the FIRST calculator). A failure here means the arithmetic changed, not the test.
const GOLDEN_V4: readonly {
  readonly name: string;
  readonly vector: string;
  readonly score: number;
  readonly severity: string;
  readonly nomenclature: string;
}[] = [
  {
    name: 'full impact on every subsequent system',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H',
    score: 10.0,
    severity: 'critical',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'no impact at all',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 0.0,
    severity: 'none',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'full system impact, no subsequent impact',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
    score: 9.3,
    severity: 'critical',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'no system impact, full subsequent impact',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:H/SI:H/SA:H',
    score: 7.9,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'high confidentiality only (the workspace fixture)',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 8.7,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'specification example B (physical, low privilege)',
    vector: 'CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 1.0,
    severity: 'low',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'local, low privilege, user interaction',
    vector: 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L',
    score: 5.2,
    severity: 'medium',
    nomenclature: 'CVSS-B',
  },
  {
    name: 'Base with a Threat metric lowers the score (CVSS-BT)',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:U',
    score: 9.1,
    severity: 'critical',
    nomenclature: 'CVSS-BT',
  },
  {
    name: 'Base with Environmental metrics raises the score (CVSS-BE)',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/MVI:L/MSA:S',
    score: 9.8,
    severity: 'critical',
    nomenclature: 'CVSS-BE',
  },
  {
    name: 'Base, Threat and Environmental (CVSS-BTE)',
    vector:
      'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:P/VC:N/VI:H/VA:H/SC:N/SI:L/SA:L/E:P/CR:H/IR:M/AR:H/MAV:A/MAT:P/MPR:N/MVI:H/MVA:N/MSI:H/MSA:N/S:N/V:C/U:Amber',
    score: 4.7,
    severity: 'medium',
    nomenclature: 'CVSS-BTE',
  },
  {
    name: 'Environmental only (CVSS-BE)',
    vector: 'CVSS:4.0/AV:N/AC:H/AT:N/PR:H/UI:N/VC:N/VI:N/VA:H/SC:H/SI:H/SA:H/CR:L/IR:L/AR:L',
    score: 5.8,
    severity: 'medium',
    nomenclature: 'CVSS-BE',
  },
  {
    name: 'Threat metric with a low score (CVSS-BT, rounds to one decimal)',
    vector: 'CVSS:4.0/AV:N/AC:L/AT:P/PR:L/UI:A/VC:L/VI:L/VA:N/SC:N/SI:N/SA:N/E:U',
    score: 0.4,
    severity: 'low',
    nomenclature: 'CVSS-BT',
  },
];

const BASE_HIGH = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N';

/** The error a call throws, or `undefined` when it does not throw. */
function errorOf(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A severity block that is consistent with `BASE_HIGH` (8.7, high, CVSS-B). */
function consistent(overrides: Partial<Severity['cvss4']> = {}): Severity {
  return {
    cvss4: {
      vector: BASE_HIGH,
      score: 8.7,
      severity: 'high',
      nomenclature: 'CVSS-B',
      ...overrides,
    },
  };
}

describe('computeCvss4 golden vectors', () => {
  it.each(GOLDEN_V4)('scores $name', ({ vector, score, severity, nomenclature }) => {
    const result = computeCvss4(vector);
    expect(result.score).toBe(score);
    expect(result.severity).toBe(severity);
    expect(result.nomenclature).toBe(nomenclature);
  });

  it('gives the same answer for a vector that spells out Not Defined values (X) and the Base-only vector', () => {
    const base = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
    const explicit = `${base}/E:X/CR:X/IR:X/AR:X/MAV:X/MAC:X/MAT:X/MPR:X/MUI:X/MVC:X/MVI:X/MVA:X/MSC:X/MSI:X/MSA:X`;
    expect(computeCvss4(explicit)).toEqual(computeCvss4(base));
    expect(computeCvss4(explicit).nomenclature).toBe('CVSS-B');
  });

  it('keeps the Supplemental metrics out of the score and leaves them as they are', () => {
    const plain = 'CVSS:4.0/AV:P/AC:H/AT:P/PR:L/UI:P/VC:H/VI:H/VA:H/SC:L/SI:L/SA:L/E:A';
    const supplemental = `${plain}/S:P/AU:Y/R:A/V:D/RE:L/U:Red`;
    expect(computeCvss4(supplemental).score).toBe(computeCvss4(plain).score);
    expect(computeCvss4(supplemental).nomenclature).toBe('CVSS-BT');
  });

  it('never returns a score outside 0.0 to 10.0 with more than one decimal', () => {
    const metric = (values: readonly string[]) => fc.constantFrom(...values);
    const impact = metric(['H', 'L', 'N']);
    const arbitrary = fc.record({
      av: metric(['N', 'A', 'L', 'P']),
      ac: metric(['L', 'H']),
      at: metric(['N', 'P']),
      pr: metric(['N', 'L', 'H']),
      ui: metric(['N', 'P', 'A']),
      vc: impact,
      vi: impact,
      va: impact,
      sc: impact,
      si: impact,
      sa: impact,
      e: metric(['X', 'A', 'P', 'U']),
    });
    fc.assert(
      fc.property(arbitrary, (m) => {
        const vector = `CVSS:4.0/AV:${m.av}/AC:${m.ac}/AT:${m.at}/PR:${m.pr}/UI:${m.ui}/VC:${m.vc}/VI:${m.vi}/VA:${m.va}/SC:${m.sc}/SI:${m.si}/SA:${m.sa}/E:${m.e}`;
        const { score, severity, nomenclature } = computeCvss4(vector);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(10);
        expect(Math.round(score * 10)).toBe(score * 10);
        expect(severity).toBe(
          score === 0
            ? 'none'
            : score < 4
              ? 'low'
              : score < 7
                ? 'medium'
                : score < 9
                  ? 'high'
                  : 'critical',
        );
        expect(nomenclature).toBe(m.e === 'X' ? 'CVSS-B' : 'CVSS-BT');
      }),
      { numRuns: 200 },
    );
  });
});

describe('computeCvss4 malformed vectors', () => {
  const full = BASE_HIGH;
  it.each([
    ['a missing CVSS:4.0 prefix', full.replace('CVSS:4.0/', '')],
    ['a CVSS 3.1 prefix', full.replace('CVSS:4.0/', 'CVSS:3.1/')],
    ['a mandatory Base metric that is missing', full.replace('/VA:N', '')],
    ['an unknown metric', `${full}/ZZ:A`],
    ['a metric that is defined twice', `${full}/E:A/E:X`],
    ['a metric without a value', `${full}/E`],
    ['a lower-case metric name', full.replace('/UI:N', '/ui:N')],
    ['an empty metric', `${full}/`],
    ['a metric value the specification does not allow', full.replace('/AV:N', '/AV:F')],
    [
      'metrics out of the specified order',
      full.replace('CVSS:4.0/AV:N/AC:L', 'CVSS:4.0/AC:L/AV:N'),
    ],
    ['an empty vector', ''],
  ])('rejects %s with a clear validation error', (_label, vector) => {
    expect(() => computeCvss4(vector)).toThrow(CvssVectorError);
    expect(() => computeCvss4(vector)).toThrow(ValidationError);
  });

  it('names the missing Base metric in the message', () => {
    const error = errorOf(() => computeCvss4(full.replace('/VA:N', '')));
    expect(error).toBeInstanceOf(CvssVectorError);
    expect((error as CvssVectorError).message).toContain('missing mandatory Base metric VA');
    expect((error as CvssVectorError).code).toBe('VALIDATION_FAILED');
  });

  it('does not echo the rejected value in the client detail or the message', () => {
    const error = errorOf(() => computeCvss4(full.replace('/AV:N', '/AV:SECRET-VALUE')));
    expect(error).toBeInstanceOf(CvssVectorError);
    expect((error as CvssVectorError).detail).not.toContain('SECRET-VALUE');
    expect((error as CvssVectorError).message).not.toContain('SECRET-VALUE');
  });
});

describe('computeCvss31 (legacy reference)', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8, 'critical'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10, 'critical'],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0, 'none'],
  ])('scores %s', (vector, score, severity) => {
    expect(computeCvss31(vector)).toEqual({ score, severity });
  });

  it('refuses a v3.1 vector without its prefix or with a missing metric', () => {
    expect(() => computeCvss31('CVSS:4.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toThrow(
      CvssVectorError,
    );
    expect(() => computeCvss31('CVSS:3.1/AV:N')).toThrow(CvssVectorError);
  });
});

describe('assertSeverityMatchesVectors', () => {
  it('accepts a severity whose score, band and nomenclature follow from its vector', () => {
    expect(() => {
      assertSeverityMatchesVectors(consistent());
    }).not.toThrow();
  });

  it('rejects a stored score that differs from the vector', () => {
    expect(() => {
      assertSeverityMatchesVectors(consistent({ score: 8.8 }));
    }).toThrow(CvssVectorScoreMismatchError);
  });

  it('rejects a stored band that differs from the score', () => {
    expect(() => {
      assertSeverityMatchesVectors(consistent({ severity: 'critical' }));
    }).toThrow(CvssVectorScoreMismatchError);
  });

  it('rejects a nomenclature that does not reflect the metric groups present', () => {
    expect(() => {
      assertSeverityMatchesVectors(
        consistent({ vector: `${BASE_HIGH}/E:U`, nomenclature: 'CVSS-B' }),
      );
    }).toThrow(CvssVectorScoreMismatchError);
  });

  it('refuses with the stable code and an HTTP 422 problem', () => {
    const error = errorOf(() => {
      assertSeverityMatchesVectors(consistent({ score: 1.0 }));
    });
    expect(error).toBeInstanceOf(AppError);
    const err = error as CvssVectorScoreMismatchError;
    expect(err.code).toBe('CVSS_VECTOR_SCORE_MISMATCH');
    expect(err.httpStatus).toBe(422);
    expect(err.version).toBe('4.0');
  });

  it('checks the CVSS v3.1 block too, and lets it diverge in band from v4.0 without refusing', () => {
    const divergent: Severity = {
      cvss4: consistent().cvss4,
      cvss31: {
        vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        score: 9.8,
        severity: 'critical',
      },
    };
    expect(() => {
      assertSeverityMatchesVectors(divergent);
    }).not.toThrow();
    const wrong: Severity = {
      cvss4: consistent().cvss4,
      cvss31: {
        vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        score: 5.0,
        severity: 'medium',
      },
    };
    expect(() => {
      assertSeverityMatchesVectors(wrong);
    }).toThrow(CvssVectorScoreMismatchError);
  });

  it('refuses a malformed vector before it compares anything', () => {
    expect(() => {
      assertSeverityMatchesVectors(consistent({ vector: 'CVSS:4.0/AV:N' }));
    }).toThrow(CvssVectorError);
  });
});
