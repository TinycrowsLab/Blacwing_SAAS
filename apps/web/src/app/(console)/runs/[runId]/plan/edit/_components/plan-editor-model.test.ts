import { describe, expect, it } from 'vitest';

import {
  budgetView,
  canEditPlan,
  caseFormDefaults,
  caseFormSchema,
  createBody,
  diffRows,
  isEditableVersion,
  isRemoved,
  isStaleWrite,
  parseRoles,
  parseTargets,
  patchBody,
  STALE_MESSAGE,
  submitBlockReason,
  writeErrorMessage,
} from './plan-editor-model';
import { ApiError } from '../../../../../../../lib/api-error';

import type { PlanDiff, PlanViolation, TestCaseView } from '@blackwing/contracts';

const CASE_ID = '0198f0a0-0000-7000-8000-0000000000c1';
const OTHER_ID = '0198f0a0-0000-7000-8000-0000000000c2';

const testCase = (over: Partial<TestCaseView> = {}): TestCaseView => ({
  caseId: CASE_ID,
  planId: '0198f0a0-0000-7000-8000-0000000000d1',
  etag: '"5b1d0c9a3e2f"',
  class: 'passive',
  title: 'Login rate limit is enforced',
  status: 'proposed',
  statusReason: null,
  refs: { owasp: ['A07'], wstg: ['WSTG-ATHN-03'], asvs: ['2.2.1'] },
  cweCandidates: ['CWE-307'],
  targets: ['https://app.example.test/login', 'https://app.example.test/reset'],
  roles: ['anonymous', 'user'],
  budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 1, maxBytes: 1048576 },
  oracle: { type: 'status_code', params: { expected: 429 } },
  negativeControl: { type: 'status_code', params: { expected: 200 } },
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

const violation = (code: PlanViolation['code']): PlanViolation => ({
  code,
  caseId: null,
  policyId: null,
  message: `${code} message`,
});

describe('canEditPlan', () => {
  it('lets an AppSec Engineer edit and hides edit controls from an approver', () => {
    expect(canEditPlan(['appsec_engineer'])).toBe(true);
    expect(canEditPlan(['asset_owner'])).toBe(false);
  });

  it('ignores unknown roles and an empty role list (fails closed)', () => {
    expect(canEditPlan([])).toBe(false);
    expect(canEditPlan(['not-a-role', 'also-unknown'])).toBe(false);
  });
});

describe('version and removal state', () => {
  it('edits only a draft version; approved and superseded versions are read-only', () => {
    expect(isEditableVersion('draft')).toBe(true);
    expect(isEditableVersion('proposed')).toBe(false);
    expect(isEditableVersion('approved')).toBe(false);
    expect(isEditableVersion('superseded')).toBe(false);
  });

  it('marks a removed case so it is never edited again', () => {
    expect(isRemoved(testCase({ status: 'removed', statusReason: 'dropped' }))).toBe(true);
    expect(isRemoved(testCase())).toBe(false);
  });
});

describe('write errors', () => {
  it('treats a 412 ETAG_MISMATCH as stale and asks for a reload, not a retry', () => {
    const error = new ApiError({
      status: 412,
      code: 'ETAG_MISMATCH',
      title: 'Precondition failed',
    });
    expect(isStaleWrite(error)).toBe(true);
    expect(writeErrorMessage(error)).toBe(STALE_MESSAGE);
  });

  it('treats a bare 412 as stale too, whatever its code', () => {
    const error = new ApiError({
      status: 412,
      code: 'PRECONDITION_FAILED',
      title: 'Precondition failed',
    });
    expect(isStaleWrite(error)).toBe(true);
  });

  it('shows the server detail for other API errors', () => {
    const error = new ApiError({
      status: 409,
      code: 'PLAN_VERSION_IMMUTABLE',
      title: 'Conflict',
      detail: 'This version is approved.',
    });
    expect(isStaleWrite(error)).toBe(false);
    expect(writeErrorMessage(error)).toBe('This version is approved.');
  });

  it('falls back to the title when an API error has no detail', () => {
    const error = new ApiError({ status: 500, code: 'HTTP_ERROR', title: 'Server error' });
    expect(writeErrorMessage(error)).toBe('Server error');
  });

  it('never reports a network or unknown failure as a stale write', () => {
    expect(isStaleWrite(new Error('boom'))).toBe(false);
    expect(writeErrorMessage(new Error('boom'))).toMatch(/Nothing was written/);
  });
});

describe('diffRows', () => {
  it('lists added, removed and one row per modified field, in the order given', () => {
    const diff: PlanDiff = {
      fromVersion: 1,
      toVersion: 2,
      added: [{ caseId: OTHER_ID, title: 'New case' }],
      removed: [{ caseId: CASE_ID, title: 'Old case' }],
      modified: [
        {
          caseId: CASE_ID,
          title: 'Login rate limit is enforced',
          changes: [
            { field: 'title', before: 'Old', after: 'New' },
            { field: 'targets', before: ['a'], after: ['a', 'b'] },
          ],
        },
      ],
    };
    const rows = diffRows(diff);
    expect(rows.map((row) => row.kind)).toEqual(['added', 'removed', 'modified', 'modified']);
    expect(rows[2]).toMatchObject({ field: 'title', before: '"Old"', after: '"New"' });
    expect(rows[3]).toMatchObject({ field: 'targets', before: '["a"]', after: '["a","b"]' });
  });

  it('renders a null before or after as an absent value, not the string "null"', () => {
    const rows = diffRows({
      fromVersion: 1,
      toVersion: 2,
      added: [],
      removed: [],
      modified: [
        {
          caseId: CASE_ID,
          title: 't',
          changes: [{ field: 'oracle', before: null, after: { type: 'status_code', params: {} } }],
        },
      ],
    });
    expect(rows[0]?.before).toBeNull();
    expect(rows[0]?.after).toBe('{"type":"status_code","params":{}}');
  });

  it('returns no rows for identical versions', () => {
    expect(
      diffRows({ fromVersion: 1, toVersion: 2, added: [], removed: [], modified: [] }),
    ).toEqual([]);
  });
});

describe('budgetView', () => {
  const totals = {
    totalRequests: 120,
    totalBytes: 4096,
    perClassCounts: { passive: 3, active_safe: 1, state_changing: 0, destructive: 0 },
  };

  it('lists every class with its count and does not flag an in-budget plan', () => {
    const view = budgetView(totals, []);
    expect(view.overBudget).toBe(false);
    expect(view.totalRequests).toBe(120);
    expect(view.classes.map((entry) => entry.class)).toEqual([
      'passive',
      'active_safe',
      'state_changing',
      'destructive',
    ]);
    expect(view.classes[0]?.count).toBe(3);
  });

  it('flags an over-budget plan from the server violation, not from a local guess', () => {
    expect(budgetView(totals, [violation('PLAN_BUDGET_EXCEEDED')]).overBudget).toBe(true);
    expect(budgetView(totals, [violation('PLAN_TARGET_OUT_OF_SCOPE')]).overBudget).toBe(false);
  });
});

describe('form parsing', () => {
  it('splits targets by line and roles by comma, dropping blanks and spaces', () => {
    expect(parseTargets('  https://a.example.test \n\n https://b.example.test  \n')).toEqual([
      'https://a.example.test',
      'https://b.example.test',
    ]);
    expect(parseRoles(' anonymous , , user ,')).toEqual(['anonymous', 'user']);
  });

  it('keeps Unicode titles and targets as entered', () => {
    expect(parseTargets('https://例え.example.test/ünïcode')).toEqual([
      'https://例え.example.test/ünïcode',
    ]);
  });

  it('builds a PATCH with only the editable fields, leaving oracle and refs to the server', () => {
    const parsed = caseFormSchema.parse({ ...caseFormDefaults(testCase()), title: 'Renamed' });
    expect(patchBody(parsed)).toEqual({
      title: 'Renamed',
      class: 'passive',
      targets: ['https://app.example.test/login', 'https://app.example.test/reset'],
      roles: ['anonymous', 'user'],
      budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 1, maxBytes: 1048576 },
    });
  });

  it('builds the POST body of a new case with its oracle type and no negative control', () => {
    const parsed = caseFormSchema.parse({
      title: '  Session fixation check  ',
      class: 'active_safe',
      targets: 'https://app.example.test/login',
      roles: 'user',
      maxRequests: '20',
      maxRps: '1.5',
      maxConcurrency: '2',
      maxBytes: '2048',
      oracleType: ' status_code ',
    });
    expect(createBody(parsed)).toEqual({
      class: 'active_safe',
      title: 'Session fixation check',
      refs: { owasp: [], wstg: [], asvs: [] },
      cweCandidates: [],
      targets: ['https://app.example.test/login'],
      roles: ['user'],
      budget: { maxRequests: 20, maxRps: 1.5, maxConcurrency: 2, maxBytes: 2048 },
      oracle: { type: 'status_code', params: {} },
      negativeControl: null,
    });
  });

  it('refuses an empty title, an empty target list and a non-integer request count', () => {
    const base = caseFormDefaults(testCase());
    expect(caseFormSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
    expect(caseFormSchema.safeParse({ ...base, targets: '\n  \n' }).success).toBe(false);
    expect(caseFormSchema.safeParse({ ...base, maxRequests: 1.5 }).success).toBe(false);
    expect(caseFormSchema.safeParse({ ...base, maxRequests: 0 }).success).toBe(false);
    expect(caseFormSchema.safeParse({ ...base, maxRps: -1 }).success).toBe(false);
    expect(caseFormSchema.safeParse({ ...base, class: 'destructive-ish' }).success).toBe(false);
  });

  it('keeps a destructive class selectable so the server can refuse it with its own code', () => {
    // The UI does not hide it: PLAN-006 answers PLAN_CLASS_DESTRUCTIVE_BLOCKED, which is the authority.
    const base = caseFormDefaults(testCase());
    expect(caseFormSchema.safeParse({ ...base, class: 'destructive' }).success).toBe(true);
  });
});

describe('submitBlockReason', () => {
  const ready = { canEdit: true, draft: true, check: 'valid' as const };

  it('allows a validated draft from a role that may edit', () => {
    expect(submitBlockReason(ready)).toBeNull();
  });

  it('refuses a role without test plan edit access, before anything else', () => {
    expect(submitBlockReason({ ...ready, canEdit: false, check: 'invalid' })).toMatch(
      /edit access/,
    );
  });

  it('refuses a version that is not a draft', () => {
    expect(submitBlockReason({ ...ready, draft: false })).toMatch(/Only a draft version/);
  });

  it('refuses while validation is running, never on a stale "valid"', () => {
    expect(submitBlockReason({ ...ready, check: 'checking' })).toMatch(/Wait for validation/);
  });

  it('refuses when the plan could not be validated at all', () => {
    expect(submitBlockReason({ ...ready, check: 'unknown' })).toMatch(/could not be validated/);
  });

  it('refuses a plan with violations', () => {
    expect(submitBlockReason({ ...ready, check: 'invalid' })).toMatch(/Fix the violations/);
  });
});
