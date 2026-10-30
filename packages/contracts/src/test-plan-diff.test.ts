import { describe, expect, it } from 'vitest';

import { planDiffSchema } from './test-plan-api.js';

const CASE_ID = '0198f0a0-0000-7000-8000-0000000000c1';

const valid = {
  fromVersion: 1,
  toVersion: 2,
  added: [{ caseId: CASE_ID, title: 'New' }],
  removed: [],
  modified: [
    {
      caseId: CASE_ID,
      title: 'Login',
      changes: [{ field: 'status', before: 'proposed', after: 'approved' }],
    },
  ],
};

describe('planDiffSchema', () => {
  it('accepts a diff with added, removed and modified entries', () => {
    expect(planDiffSchema.parse(valid)).toEqual(valid);
  });

  it('refuses an unknown field name in a change (only the diffed fields exist)', () => {
    const bad = {
      ...valid,
      modified: [
        { caseId: CASE_ID, title: 'x', changes: [{ field: 'secret', before: 1, after: 2 }] },
      ],
    };
    expect(planDiffSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses unknown keys at every level, and a non-UUID case id', () => {
    expect(planDiffSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(
      planDiffSchema.safeParse({ ...valid, added: [{ caseId: 'not-a-uuid', title: 'x' }] }).success,
    ).toBe(false);
  });

  it('refuses a version below 1', () => {
    expect(planDiffSchema.safeParse({ ...valid, fromVersion: 0 }).success).toBe(false);
  });
});
