import { describe, expect, it } from 'vitest';

import {
  COVERAGE_JSON_MAX_BYTES,
  COVERAGE_OUTCOMES,
  coverageManifestEntrySchema,
  coverageManifestStatusSchema,
  coverageOutcomeSchema,
} from '../index.js';

const CASE_ID = '0190f2a4-7b6c-7d2e-8f00-1234567890ab';
const SUBTASK_ID = '0190f2a4-7b6c-7d2e-8f00-abcdefabcdef';

/** A valid executed entry; each test overrides the fields it needs. */
function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testCaseId: CASE_ID,
    title: 'Reflected XSS on search',
    class: 'active_safe',
    owaspRefs: ['A03'],
    wstgRefs: ['WSTG-INPV-01'],
    cweCandidates: ['CWE-79'],
    targets: ['https://app.example.test/search'],
    roles: ['anonymous'],
    outcome: 'executed',
    reason: null,
    subtaskId: null,
    budgetUsed: { requests: 12 },
    ...over,
  };
}

describe('coverageOutcomeSchema', () => {
  it('lists exactly the coverage outcomes of CONTEXT_PACK §7 and §4.4', () => {
    expect([...COVERAGE_OUTCOMES]).toEqual([
      'executed',
      'skipped',
      'blocked',
      'model_declined',
      'out_of_budget',
      'gate_denied',
      'not_applicable',
      'failed',
    ]);
  });

  it('rejects an unknown outcome', () => {
    expect(coverageOutcomeSchema.safeParse('pending').success).toBe(false);
    expect(coverageOutcomeSchema.safeParse('removed').success).toBe(false);
  });
});

describe('coverageManifestStatusSchema', () => {
  it('accepts open and finalised only', () => {
    expect(coverageManifestStatusSchema.parse('open')).toBe('open');
    expect(coverageManifestStatusSchema.parse('finalised')).toBe('finalised');
    expect(coverageManifestStatusSchema.safeParse('closed').success).toBe(false);
  });
});

describe('coverageManifestEntrySchema', () => {
  it('accepts a valid executed entry', () => {
    expect(coverageManifestEntrySchema.parse(entry())).toMatchObject({ outcome: 'executed' });
  });

  it('rejects an unknown outcome', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ outcome: 'maybe' })).success).toBe(false);
  });

  it.each(COVERAGE_OUTCOMES.filter((outcome) => outcome !== 'executed'))(
    'requires a reason for the %s outcome',
    (outcome) => {
      expect(coverageManifestEntrySchema.safeParse(entry({ outcome, reason: null })).success).toBe(
        false,
      );
      expect(
        coverageManifestEntrySchema.safeParse(entry({ outcome, reason: 'not run here' })).success,
      ).toBe(true);
    },
  );

  it('refuses a reason on an executed entry', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ reason: 'why' })).success).toBe(false);
  });

  it('rejects an unknown key (strict object: no smuggled columns)', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ tenantId: CASE_ID })).success).toBe(false);
  });

  it('rejects a non-UUIDv7 test case id and a bad intrusiveness class', () => {
    expect(
      coverageManifestEntrySchema.safeParse(
        entry({ testCaseId: '11111111-1111-4111-8111-111111111111' }),
      ).success,
    ).toBe(false);
    expect(coverageManifestEntrySchema.safeParse(entry({ class: 'destructive-ish' })).success).toBe(
      false,
    );
  });

  it('accepts a subtask id and rejects a malformed one', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ subtaskId: SUBTASK_ID })).success).toBe(
      true,
    );
    expect(coverageManifestEntrySchema.safeParse(entry({ subtaskId: 'sub_1' })).success).toBe(
      false,
    );
  });

  it('rejects a CWE that is not CWE-<number>', () => {
    expect(
      coverageManifestEntrySchema.safeParse(entry({ cweCandidates: ['cwe-79'] })).success,
    ).toBe(false);
  });

  it('requires at least one target and caps the target list', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ targets: [] })).success).toBe(false);
    const tooMany = Array.from({ length: 65 }, (_, i) => `https://t${i}.example.test/`);
    expect(coverageManifestEntrySchema.safeParse(entry({ targets: tooMany })).success).toBe(false);
  });

  it('caps the opaque jsonb fields in bytes (oversized targets and budget are refused)', () => {
    const huge = 'x'.repeat(COVERAGE_JSON_MAX_BYTES);
    expect(
      coverageManifestEntrySchema.safeParse(entry({ budgetUsed: { blob: huge } })).success,
    ).toBe(false);
    expect(
      coverageManifestEntrySchema.safeParse(entry({ targets: [`https://${huge}.test/`] })).success,
    ).toBe(false);
  });

  it('stores title and reason in Unicode NFC', () => {
    const decomposed = 'Café login';
    const parsed = coverageManifestEntrySchema.parse(
      entry({ title: decomposed, outcome: 'skipped', reason: 'Café down' }),
    );
    expect(parsed.title).toBe('Café login');
    expect(parsed.reason).toBe('Café down');
  });

  it('rejects an empty title and an empty reason', () => {
    expect(coverageManifestEntrySchema.safeParse(entry({ title: '' })).success).toBe(false);
    expect(
      coverageManifestEntrySchema.safeParse(entry({ outcome: 'failed', reason: '' })).success,
    ).toBe(false);
  });
});
