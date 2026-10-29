import { describe, expect, it } from 'vitest';

import {
  ASSESSMENT_REQUEST_ASSETS_MAX,
  createAssessmentRequestSchema,
  patchAssessmentRequestSchema,
} from './assessment-request-api.js';

const ASSET = '0198f0a0-0000-7000-8000-0000000000e1';
const base = { mode: 'grey', objective: 'Test the login flow' };

describe('createAssessmentRequestSchema', () => {
  it('applies the defaults: no asset yet, active_safe ceiling, console trigger', () => {
    const parsed = createAssessmentRequestSchema.parse(base);
    expect(parsed).toEqual({
      ...base,
      assetIds: [],
      maxIntrusiveness: 'active_safe',
      trigger: 'console',
    });
  });

  it('trims the objective and refuses a blank one', () => {
    expect(createAssessmentRequestSchema.parse({ ...base, objective: '  hi  ' }).objective).toBe(
      'hi',
    );
    expect(createAssessmentRequestSchema.safeParse({ ...base, objective: '   ' }).success).toBe(
      false,
    );
  });

  it('refuses destructive as a ceiling and any unknown key', () => {
    expect(
      createAssessmentRequestSchema.safeParse({ ...base, maxIntrusiveness: 'destructive' }).success,
    ).toBe(false);
    expect(createAssessmentRequestSchema.safeParse({ ...base, requestedBy: ASSET }).success).toBe(
      false,
    );
  });

  it('caps the asset list and rejects a non-uuid asset id', () => {
    const tooMany = Array.from({ length: ASSESSMENT_REQUEST_ASSETS_MAX + 1 }, () => ASSET);
    expect(createAssessmentRequestSchema.safeParse({ ...base, assetIds: tooMany }).success).toBe(
      false,
    );
    expect(
      createAssessmentRequestSchema.safeParse({ ...base, assetIds: ['not-a-uuid'] }).success,
    ).toBe(false);
  });
});

describe('patchAssessmentRequestSchema', () => {
  it('refuses an empty patch, even though the create defaults would fill the body', () => {
    expect(patchAssessmentRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single changed field and injects no defaults into it', () => {
    expect(patchAssessmentRequestSchema.parse({ objective: 'New' })).toEqual({ objective: 'New' });
  });
});
