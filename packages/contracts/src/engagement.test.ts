import { describe, expect, it } from 'vitest';

import { TEST_CASE_STATUSES } from './entities/test-case.js';
import {
  canTransitionTestCase,
  DISPATCH_BRIEF_MAX_BYTES,
  engagementDispatchInputSchema,
  engagementMarkTestCaseInputSchema,
  engagementScopeExceptionInputSchema,
  engagementSubtaskResultSchema,
  executionWorkflowId,
  TEST_CASE_MARK_STATUSES,
  TEST_CASE_STATUS_TRANSITIONS,
} from './index.js';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';
const SUBTASK = '01890a5d-ac96-774b-bcce-b302099a8058';

const brief = {
  targets: ['https://lab.example.test/login'],
  class: 'passive',
  oracle: { type: 'http_status', params: { status: 200 } },
  negativeControl: { type: 'status_diff', params: {} },
  budget: { maxRequests: 100, maxRps: 5, maxConcurrency: 2, maxBytes: 1_000_000 },
  standardRefs: { wstg: ['WSTG-ATHN-01'], cwe: [], owasp: [] },
};
const dispatch = { persona: 'auth-logic-specialist', subtaskId: SUBTASK, testCaseId: ID, brief };

describe('test-case status transitions (MCP-012)', () => {
  it('covers every test-case status in the transition table', () => {
    expect(Object.keys(TEST_CASE_STATUS_TRANSITIONS).sort()).toEqual(
      [...TEST_CASE_STATUSES].sort(),
    );
  });

  it('gives terminal outcomes no way out', () => {
    for (const from of [
      'executed',
      'skipped',
      'failed',
      'model_declined',
      'not_applicable',
    ] as const) {
      expect(TEST_CASE_STATUS_TRANSITIONS[from]).toEqual([]);
    }
  });

  it('allows the execution path and a retry of a blocked case, and refuses the rest', () => {
    expect(canTransitionTestCase('approved', 'executing')).toBe(true);
    expect(canTransitionTestCase('executing', 'executed')).toBe(true);
    expect(canTransitionTestCase('blocked', 'executing')).toBe(true);
    expect(canTransitionTestCase('approved', 'executed')).toBe(false);
    expect(canTransitionTestCase('proposed', 'executing')).toBe(false);
    expect(canTransitionTestCase('executed', 'executing')).toBe(false);
    expect(canTransitionTestCase('removed', 'approved')).toBe(false);
  });

  it('keeps the orchestrator-settable statuses inside the test-case enum', () => {
    for (const status of TEST_CASE_MARK_STATUSES) {
      expect(TEST_CASE_STATUSES).toContain(status);
    }
    expect(TEST_CASE_MARK_STATUSES).not.toContain('approved');
    expect(TEST_CASE_MARK_STATUSES).not.toContain('removed');
  });
});

describe('engagement inputs', () => {
  it('accepts a bounded, self-contained dispatch', () => {
    expect(engagementDispatchInputSchema.safeParse(dispatch).success).toBe(true);
  });

  it('refuses a brief larger than the byte cap (briefs must stay bounded, §8.2)', () => {
    const big = {
      ...dispatch,
      brief: {
        ...brief,
        targets: Array.from(
          { length: 100 },
          (_, i) => `https://lab.example.test/${String(i)}/${'a'.repeat(200)}`,
        ),
      },
    };
    expect(JSON.stringify(big.brief).length).toBeGreaterThan(DISPATCH_BRIEF_MAX_BYTES);
    expect(engagementDispatchInputSchema.safeParse(big).success).toBe(false);
  });

  it('refuses unknown fields on a dispatch, so the run id cannot ride along', () => {
    expect(engagementDispatchInputSchema.safeParse({ ...dispatch, runId: ID }).success).toBe(false);
  });

  it('refuses a mark with a status outside the execution outcomes', () => {
    expect(
      engagementMarkTestCaseInputSchema.safeParse({
        testCaseId: ID,
        status: 'approved',
        reason: 'x',
      }).success,
    ).toBe(false);
    expect(
      engagementMarkTestCaseInputSchema.safeParse({
        testCaseId: ID,
        status: 'executed',
        reason: 'x',
      }).success,
    ).toBe(true);
  });

  it('requires a target and a reason for a scope exception', () => {
    expect(
      engagementScopeExceptionInputSchema.safeParse({ target: 'https://a.test' }).success,
    ).toBe(false);
    expect(engagementScopeExceptionInputSchema.safeParse({ target: '', reason: 'x' }).success).toBe(
      false,
    );
  });

  it('answers a pending subtask result with null and pending, never an error shape', () => {
    expect(
      engagementSubtaskResultSchema.safeParse({
        subtaskId: SUBTASK,
        status: 'running',
        pending: true,
        result: null,
      }).success,
    ).toBe(true);
  });

  it('names the Run Controller workflow per run', () => {
    expect(executionWorkflowId(ID)).toBe(`execution-${ID}`);
  });
});
