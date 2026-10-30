import { z } from 'zod';

import {
  INTRUSIVENESS_CLASSES,
  isRole,
  LIMITS,
  ROLE_PERMISSIONS,
  type IntrusivenessClass,
  type PlanBudgetTotals,
  type PlanDiff,
  type PlanViolation,
  type TestCaseCreateBody,
  type TestCasePatchBody,
  type TestCaseView,
} from '@blackwing/contracts';

import { isApiError } from '../../../../../../../lib/api-error';

/** The one version status a case may be added to, edited or removed in (PLAN-005: approved versions are frozen). */
export const EDITABLE_VERSION_STATUS = 'draft';

/** The violation code that marks a plan as over the SA or run budget (PLAN-006). */
const BUDGET_EXCEEDED_CODE = 'PLAN_BUDGET_EXCEEDED';

/** HTTP 412: the `If-Match` validator no longer matches the resource. */
const HTTP_PRECONDITION_FAILED = 412;

/** What the last validation said about the plan, as the submit rule needs it. */
export type SubmitCheck = 'valid' | 'invalid' | 'checking' | 'unknown';

/**
 * Why the plan cannot be submitted to Gate 1 right now, or `null` when it can. Mirrors the server's rule
 * (`GATE1_PLAN_INVALID`, PLAN-006): only a draft, validated with no violations, by a role that may edit.
 */
export function submitBlockReason(input: {
  readonly canEdit: boolean;
  readonly draft: boolean;
  readonly check: SubmitCheck;
}): string | null {
  if (!input.canEdit) return 'Only a role with test plan edit access can submit this plan.';
  if (!input.draft) return 'Only a draft version can be submitted. Start a new draft to change it.';
  if (input.check === 'checking') return 'Wait for validation to finish before you submit.';
  if (input.check === 'unknown')
    return 'The plan could not be validated, so it cannot be submitted.';
  if (input.check === 'invalid') return 'Fix the violations above before you submit.';
  return null;
}

/** Cosmetic only: the server enforces `testplan:edit` on every write. A role without it gets a read-only view. */
export function canEditPlan(roles: readonly string[]): boolean {
  return roles.some((role) => isRole(role) && ROLE_PERMISSIONS[role].includes('testplan:edit'));
}

export function isEditableVersion(status: string): boolean {
  return status === EDITABLE_VERSION_STATUS;
}

/** A write answered with a stale validator (412 `ETAG_MISMATCH`): the screen must ask for a reload, not retry. */
export const STALE_MESSAGE =
  'This plan changed while you were editing. Reload it to see the latest cases, then make the change again.';

export function isStaleWrite(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === 'ETAG_MISMATCH' || error.status === HTTP_PRECONDITION_FAILED)
  );
}

/** The text shown for a failed write. Stale writes get their own prompt; everything else shows the server detail. */
export function writeErrorMessage(error: unknown): string {
  if (isStaleWrite(error)) return STALE_MESSAGE;
  if (isApiError(error)) {
    return error.detail ?? error.title;
  }
  return 'The change could not be saved. Nothing was written. Try again.';
}

export interface DiffRow {
  readonly key: string;
  readonly kind: 'added' | 'removed' | 'modified';
  readonly caseId: string;
  readonly title: string;
  /** Set for `modified` only: one row per field that differs. */
  readonly field: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

/** Canonical JSON of a field value, for the before/after cells. `null` is shown as an absent value. */
function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** Flattens a `PlanDiff` into one row per change, in the server's order (sorted by caseId, then title). */
export function diffRows(diff: PlanDiff): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const added of diff.added) {
    rows.push({
      key: `added:${added.caseId}`,
      kind: 'added',
      caseId: added.caseId,
      title: added.title,
      field: null,
      before: null,
      after: null,
    });
  }
  for (const removed of diff.removed) {
    rows.push({
      key: `removed:${removed.caseId}`,
      kind: 'removed',
      caseId: removed.caseId,
      title: removed.title,
      field: null,
      before: null,
      after: null,
    });
  }
  for (const modified of diff.modified) {
    for (const change of modified.changes) {
      rows.push({
        key: `modified:${modified.caseId}:${change.field}`,
        kind: 'modified',
        caseId: modified.caseId,
        title: modified.title,
        field: change.field,
        before: show(change.before),
        after: show(change.after),
      });
    }
  }
  return rows;
}

export interface BudgetView {
  readonly overBudget: boolean;
  readonly totalRequests: number;
  readonly totalBytes: number;
  readonly classes: readonly { readonly class: IntrusivenessClass; readonly count: number }[];
}

/** The budget panel: totals from the validation result, and whether the server flagged the plan over budget. */
export function budgetView(
  totals: PlanBudgetTotals,
  violations: readonly PlanViolation[],
): BudgetView {
  return {
    overBudget: violations.some((violation) => violation.code === BUDGET_EXCEEDED_CODE),
    totalRequests: totals.totalRequests,
    totalBytes: totals.totalBytes,
    classes: INTRUSIVENESS_CLASSES.map((cls) => ({
      class: cls,
      count: totals.perClassCounts[cls],
    })),
  };
}

const MAX_BUDGET_FIELD = 1_000_000_000;

/** One list entry per line, trimmed, blanks dropped. */
export function parseTargets(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Comma-separated roles, trimmed, blanks dropped. */
export function parseRoles(text: string): string[] {
  return text
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');
}

/**
 * The case form. Client-side checks are UX only: the server re-validates every field (PLAN-005/006). The
 * budget cross-field rules (`maxRps <= maxRequests`, …) are left to the server so they are stated once.
 */
export const caseFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Give the case a title.')
    .max(LIMITS.labelMax, 'Title is too long.'),
  class: z.enum(INTRUSIVENESS_CLASSES, { error: 'Pick a class.' }),
  targets: z
    .string()
    .refine((text) => parseTargets(text).length > 0, 'Add at least one target, one per line.'),
  roles: z.string(),
  maxRequests: z.coerce
    .number()
    .int('Use a whole number.')
    .min(1, 'Must be at least 1.')
    .max(MAX_BUDGET_FIELD),
  maxRps: z.coerce.number().positive('Must be more than 0.').max(MAX_BUDGET_FIELD),
  maxConcurrency: z.coerce
    .number()
    .int('Use a whole number.')
    .min(1, 'Must be at least 1.')
    .max(MAX_BUDGET_FIELD),
  maxBytes: z.coerce
    .number()
    .int('Use a whole number.')
    .min(1, 'Must be at least 1.')
    .max(MAX_BUDGET_FIELD),
  oracleType: z.string(),
});
export type CaseFormValues = z.input<typeof caseFormSchema>;
export type CaseFormOutput = z.output<typeof caseFormSchema>;

/** The form values of an existing case, for the edit dialog. */
export function caseFormDefaults(testCase: TestCaseView): CaseFormValues {
  return {
    title: testCase.title,
    class: testCase.class,
    targets: testCase.targets.join('\n'),
    roles: testCase.roles.join(', '),
    maxRequests: testCase.budget.maxRequests,
    maxRps: testCase.budget.maxRps,
    maxConcurrency: testCase.budget.maxConcurrency,
    maxBytes: testCase.budget.maxBytes,
    oracleType: testCase.oracle?.type ?? '',
  };
}

function budgetOf(values: CaseFormOutput) {
  return {
    maxRequests: values.maxRequests,
    maxRps: values.maxRps,
    maxConcurrency: values.maxConcurrency,
    maxBytes: values.maxBytes,
  };
}

/**
 * The PATCH body of an edit: only the editable fields. The oracle, negative control and standards refs are
 * not edited here, so they are left as the server holds them.
 */
export function patchBody(values: CaseFormOutput): TestCasePatchBody {
  return {
    title: values.title,
    class: values.class,
    targets: parseTargets(values.targets),
    roles: parseRoles(values.roles),
    budget: budgetOf(values),
  };
}

/**
 * The POST body of a new case. The oracle type is required (PLAN-006 `PLAN_ORACLE_MISSING`); the server adds
 * the rest of the validation, including the negative control a state-changing case needs.
 */
export function createBody(values: CaseFormOutput): TestCaseCreateBody {
  return {
    class: values.class,
    title: values.title,
    refs: { owasp: [], wstg: [], asvs: [] },
    cweCandidates: [],
    targets: parseTargets(values.targets),
    roles: parseRoles(values.roles),
    budget: budgetOf(values),
    oracle: { type: values.oracleType.trim(), params: {} },
    negativeControl: null,
  };
}

/** Cases the table shows: removed cases stay visible in the version (PLAN-005) but are marked and never edited. */
export function isRemoved(testCase: TestCaseView): boolean {
  return testCase.status === 'removed';
}
