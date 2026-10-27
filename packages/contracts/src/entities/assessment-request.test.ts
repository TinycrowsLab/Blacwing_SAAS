import { describe, expect, it } from 'vitest';

import {
  ASSESSMENT_REQUEST_STATUSES,
  ASSESSMENT_REQUEST_TRANSITIONS,
  type AssessmentRequestStatus,
  assessmentRequestStatusSchema,
  canTransitionAssessmentRequest,
} from './assessment-request.js';

const TERMINAL: AssessmentRequestStatus[] = ['withdrawn', 'promoted', 'rejected'];

describe('assessment request statuses', () => {
  it('are exactly the five states of SCOPE-001', () => {
    expect([...ASSESSMENT_REQUEST_STATUSES].sort()).toEqual(
      ['draft', 'promoted', 'rejected', 'submitted', 'withdrawn'].sort(),
    );
  });

  it('reject any other value', () => {
    expect(assessmentRequestStatusSchema.safeParse('running').success).toBe(false);
    expect(assessmentRequestStatusSchema.safeParse('').success).toBe(false);
    expect(assessmentRequestStatusSchema.safeParse(null).success).toBe(false);
  });
});

describe('assessment request transitions', () => {
  it('allow the forward path draft -> submitted -> promoted or rejected', () => {
    expect(canTransitionAssessmentRequest('draft', 'submitted')).toBe(true);
    expect(canTransitionAssessmentRequest('submitted', 'promoted')).toBe(true);
    expect(canTransitionAssessmentRequest('submitted', 'rejected')).toBe(true);
  });

  it('allow withdrawing a draft or a submitted request', () => {
    expect(canTransitionAssessmentRequest('draft', 'withdrawn')).toBe(true);
    expect(canTransitionAssessmentRequest('submitted', 'withdrawn')).toBe(true);
  });

  it('refuse skipping submit, reopening a submitted request and leaving a terminal state', () => {
    expect(canTransitionAssessmentRequest('draft', 'promoted')).toBe(false);
    expect(canTransitionAssessmentRequest('draft', 'rejected')).toBe(false);
    expect(canTransitionAssessmentRequest('submitted', 'draft')).toBe(false);
    for (const from of TERMINAL) {
      for (const to of ASSESSMENT_REQUEST_STATUSES) {
        expect(canTransitionAssessmentRequest(from, to)).toBe(false);
      }
    }
  });

  it('refuse a no-op change to the same status', () => {
    for (const status of ASSESSMENT_REQUEST_STATUSES) {
      expect(canTransitionAssessmentRequest(status, status)).toBe(false);
    }
  });

  it('has a table entry for every status and only lists known targets', () => {
    expect(Object.keys(ASSESSMENT_REQUEST_TRANSITIONS).sort()).toEqual(
      [...ASSESSMENT_REQUEST_STATUSES].sort(),
    );
    for (const targets of Object.values(ASSESSMENT_REQUEST_TRANSITIONS)) {
      for (const target of targets) {
        expect(ASSESSMENT_REQUEST_STATUSES).toContain(target);
      }
    }
  });

  it('gives terminal states no outgoing change', () => {
    for (const from of TERMINAL) {
      expect(ASSESSMENT_REQUEST_TRANSITIONS[from]).toEqual([]);
    }
  });

  it('is frozen so a caller cannot widen the machine at runtime', () => {
    expect(Object.isFrozen(ASSESSMENT_REQUEST_TRANSITIONS)).toBe(true);
  });
});
