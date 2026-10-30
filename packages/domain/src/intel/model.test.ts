import { describe, expect, it } from 'vitest';

import { CPE_MATCHES_MAX_BYTES, CVE_DESCRIPTION_MAX_CHARS } from '@blackwing/contracts';

import {
  cveRecordSchema,
  cweEntrySchema,
  epssScoreSchema,
  findingIntelSchema,
  kevEntrySchema,
  osvAdvisorySchema,
  owaspMappingSchema,
  sourceSyncStateSchema,
} from './model.js';
import { computeCvss4 } from '../findings/cvss.js';

const CVSS31_CRITICAL = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
const CVSS40_CRITICAL = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N';

/** A complete, valid CVE record. Tests override one field at a time. */
function cve(overrides: Record<string, unknown> = {}) {
  return {
    cveId: 'CVE-2024-12345',
    published: new Date('2024-03-01T00:00:00.000Z'),
    lastModified: new Date('2024-03-02T00:00:00.000Z'),
    cvssV31: { vector: CVSS31_CRITICAL, baseScore: 9.8 },
    cvssV40: null,
    cweIds: ['CWE-89'],
    cpeMatches: [{ criteria: 'cpe:2.3:a:vendor:product:*:*:*:*:*:*:*:*' }],
    description: 'An example vulnerability.',
    sourceUpdated: new Date('2024-03-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('cveRecordSchema', () => {
  it('accepts a complete record', () => {
    expect(cveRecordSchema.safeParse(cve()).success).toBe(true);
  });

  it('keeps CVSS blocks null when the source publishes no vector, never a fabricated score', () => {
    const parsed = cveRecordSchema.parse(cve({ cvssV31: null, cvssV40: null }));
    expect(parsed.cvssV31).toBeNull();
    expect(parsed.cvssV40).toBeNull();
  });

  it('refuses a score without a vector', () => {
    expect(cveRecordSchema.safeParse(cve({ cvssV31: { baseScore: 9.8 } })).success).toBe(false);
    expect(
      cveRecordSchema.safeParse(cve({ cvssV31: { vector: '', baseScore: 9.8 } })).success,
    ).toBe(false);
  });

  it('refuses a stored score that the vector does not compute', () => {
    const result = cveRecordSchema.safeParse(
      cve({ cvssV31: { vector: CVSS31_CRITICAL, baseScore: 5 } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('baseScore must equal');
  });

  it('refuses a vector that is not a valid CVSS v3.1 vector', () => {
    const result = cveRecordSchema.safeParse(
      cve({ cvssV31: { vector: 'AV:N/AC:L', baseScore: 9.8 } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('not a valid CVSS vector');
  });

  it('accepts a CVSS v4.0 block whose score matches its vector', () => {
    const score = computeCvss4(CVSS40_CRITICAL).score;
    const parsed = cveRecordSchema.parse(
      cve({ cvssV40: { vector: CVSS40_CRITICAL, baseScore: score } }),
    );
    expect(parsed.cvssV40?.baseScore).toBe(score);
    expect(
      cveRecordSchema.safeParse(cve({ cvssV40: { vector: CVSS40_CRITICAL, baseScore: 1 } }))
        .success,
    ).toBe(false);
  });

  it('refuses an unknown key rather than storing it silently', () => {
    expect(cveRecordSchema.safeParse({ ...cve(), severityHint: 'critical' }).success).toBe(false);
  });

  it.each(['cve-2024-12345', 'CVE-24-12345', 'CVE-2024-123', 'CVE-2024-12345; DROP TABLE x'])(
    'refuses the malformed CVE id %s',
    (cveId) => {
      expect(cveRecordSchema.safeParse(cve({ cveId })).success).toBe(false);
    },
  );

  it('refuses a malformed CWE id', () => {
    expect(cveRecordSchema.safeParse(cve({ cweIds: ['CWE-abc'] })).success).toBe(false);
    expect(cveRecordSchema.safeParse(cve({ cweIds: ['CWE-0'] })).success).toBe(false);
  });

  it('caps the serialised cpe_matches per record and refuses an oversized one', () => {
    const big = 'x'.repeat(CPE_MATCHES_MAX_BYTES);
    expect(cveRecordSchema.safeParse(cve({ cpeMatches: [{ criteria: big }] })).success).toBe(false);
    const exactlyAtCap = 'x'.repeat(CPE_MATCHES_MAX_BYTES - '[{"criteria":""}]'.length);
    expect(
      cveRecordSchema.safeParse(cve({ cpeMatches: [{ criteria: exactlyAtCap }] })).success,
    ).toBe(true);
  });

  it('caps the description length', () => {
    const description = 'd'.repeat(CVE_DESCRIPTION_MAX_CHARS + 1);
    expect(cveRecordSchema.safeParse(cve({ description })).success).toBe(false);
  });
});

describe('kevEntrySchema', () => {
  const kev = {
    cveId: 'CVE-2024-12345',
    dateAdded: '2024-03-04',
    dueDate: '2024-03-25',
    knownRansomware: true,
    notes: null,
  };

  it('accepts calendar dates and refuses impossible ones', () => {
    expect(kevEntrySchema.safeParse(kev).success).toBe(true);
    expect(kevEntrySchema.safeParse({ ...kev, dateAdded: '2024-13-04' }).success).toBe(false);
    expect(kevEntrySchema.safeParse({ ...kev, dateAdded: '04/03/2024' }).success).toBe(false);
  });
});

describe('epssScoreSchema', () => {
  const epss = { cveId: 'CVE-2024-12345', epss: 0.42, percentile: 0.9, scoreDate: '2026-10-29' };

  it('keeps both probabilities within [0, 1]', () => {
    expect(epssScoreSchema.safeParse(epss).success).toBe(true);
    expect(epssScoreSchema.safeParse({ ...epss, epss: 1.2 }).success).toBe(false);
    expect(epssScoreSchema.safeParse({ ...epss, percentile: -0.1 }).success).toBe(false);
  });
});

describe('osvAdvisorySchema', () => {
  const osv = {
    osvId: 'GHSA-abcd-efgh-ijkl',
    aliases: ['CVE-2024-12345'],
    ghsaId: 'GHSA-abcd-efgh-ijkl',
    ecosystem: 'npm',
    package: 'left-pad',
    affectedRanges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.0' }] }],
    severity: [],
    modified: null,
  };

  it('accepts an advisory and refuses a malformed GHSA id', () => {
    expect(osvAdvisorySchema.safeParse(osv).success).toBe(true);
    expect(osvAdvisorySchema.safeParse({ ...osv, ghsaId: 'GHSA-ABCD-EFGH-IJKL' }).success).toBe(
      false,
    );
  });

  it('caps the affected ranges by serialised size', () => {
    const affectedRanges = [{ note: 'y'.repeat(70_000) }];
    expect(osvAdvisorySchema.safeParse({ ...osv, affectedRanges }).success).toBe(false);
  });
});

describe('cweEntrySchema', () => {
  const cwe = {
    cweId: 'CWE-89',
    name: 'Improper Neutralization of Special Elements used in an SQL Command',
    abstraction: 'Base',
    relationships: [{ nature: 'ChildOf', cweId: 'CWE-943' }],
  };

  it('accepts a catalogue entry and refuses a malformed CWE id', () => {
    expect(cweEntrySchema.safeParse(cwe).success).toBe(true);
    expect(cweEntrySchema.safeParse({ ...cwe, cweId: 'CWE-x' }).success).toBe(false);
  });

  it('caps the relationship graph by serialised size', () => {
    const relationships = [{ note: 'z'.repeat(70_000) }];
    expect(cweEntrySchema.safeParse({ ...cwe, relationships }).success).toBe(false);
  });
});

describe('owaspMappingSchema', () => {
  it('accepts only the fixed standards', () => {
    const mapping = { scheme: 'top10_2021', code: 'A03', title: 'Injection', cweIds: ['CWE-89'] };
    expect(owaspMappingSchema.safeParse(mapping).success).toBe(true);
    expect(owaspMappingSchema.safeParse({ ...mapping, scheme: 'top10_2017' }).success).toBe(false);
    expect(
      owaspMappingSchema.safeParse({ ...mapping, scheme: 'api_top10_2023', code: 'API1' }).success,
    ).toBe(true);
  });
});

describe('sourceSyncStateSchema', () => {
  const state = {
    source: 'nvd',
    lastRun: new Date('2026-10-29T10:00:00.000Z'),
    lastCursor: '2026-10-29T09:00:00.000Z',
    recordCount: 1200,
    status: 'succeeded',
    lastError: null,
  };

  it('accepts a known source and status, and refuses an unknown source or a negative count', () => {
    expect(sourceSyncStateSchema.safeParse(state).success).toBe(true);
    expect(sourceSyncStateSchema.safeParse({ ...state, source: 'shodan' }).success).toBe(false);
    expect(sourceSyncStateSchema.safeParse({ ...state, status: 'done' }).success).toBe(false);
    expect(sourceSyncStateSchema.safeParse({ ...state, recordCount: -1 }).success).toBe(false);
  });
});

describe('findingIntelSchema', () => {
  it('allows an unknown EPSS score (null) and refuses a malformed finding id', () => {
    const row = {
      findingId: '0190a7e4-1111-7a00-8000-000000000001',
      cveId: 'CVE-2024-12345',
      kev: false,
      epss: null,
      addedAt: new Date('2026-10-29T10:00:00.000Z'),
    };
    expect(findingIntelSchema.safeParse(row).success).toBe(true);
    expect(findingIntelSchema.safeParse({ ...row, findingId: 'not-a-uuid' }).success).toBe(false);
  });
});
