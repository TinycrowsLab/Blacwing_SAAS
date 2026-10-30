import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TEST_CASE_STATUSES, type TestCaseView } from '@blackwing/contracts';

import { diffPlans, type DiffablePlan } from './diff.js';

const A = '0198f0a0-0000-7000-8000-0000000000a1';
const B = '0198f0a0-0000-7000-8000-0000000000b1';
const C = '0198f0a0-0000-7000-8000-0000000000c1';
const D = '0198f0a0-0000-7000-8000-0000000000d1';

/** A test case view with sensible defaults; `overrides` set the fields a test cares about. */
function caseOf(caseId: string, overrides: Partial<TestCaseView> = {}): TestCaseView {
  return {
    caseId,
    planId: '0198f0a0-0000-7000-8000-0000000000f1',
    etag: '"5b1d0c9a3e2f"',
    class: 'passive',
    title: `case ${caseId}`,
    status: 'proposed',
    statusReason: null,
    refs: { owasp: ['A07'], wstg: ['WSTG-ATHN-03'], asvs: ['2.2.1'] },
    cweCandidates: ['CWE-307'],
    targets: ['https://app.example.test/login'],
    roles: ['anonymous'],
    budget: { maxBytes: 1024, maxConcurrency: 1, maxRequests: 50, maxRps: 2 },
    oracle: { type: 'status_code', params: { expected: 429 } },
    negativeControl: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

function planOf(version: number, cases: TestCaseView[]): DiffablePlan {
  return { version, cases };
}

describe('diffPlans', () => {
  it('is empty when a version is compared with itself (idempotent)', () => {
    const v = planOf(1, [caseOf(A), caseOf(B, { class: 'active_safe' })]);
    expect(diffPlans(v, v)).toEqual({
      fromVersion: 1,
      toVersion: 1,
      added: [],
      removed: [],
      modified: [],
    });
  });

  it('reports added and removed cases by id and title', () => {
    const from = planOf(1, [caseOf(A, { title: 'Kept' }), caseOf(B, { title: 'Dropped' })]);
    const to = planOf(2, [caseOf(A, { title: 'Kept' }), caseOf(C, { title: 'New' })]);
    const diff = diffPlans(from, to);
    expect(diff.removed).toEqual([{ caseId: B, title: 'Dropped' }]);
    expect(diff.added).toEqual([{ caseId: C, title: 'New' }]);
    expect(diff.modified).toEqual([]);
  });

  it('reports each changed field with its before and after value', () => {
    const from = planOf(1, [caseOf(A)]);
    const to = planOf(2, [
      caseOf(A, {
        class: 'active_safe',
        title: 'Renamed',
        status: 'approved',
        budget: { maxBytes: 1024, maxConcurrency: 1, maxRequests: 10, maxRps: 2 },
        oracle: { type: 'status_code', params: { expected: 403 } },
        negativeControl: {
          kind: 'known_safe_endpoint',
          description: 'Same request to the public page',
          oracleMustNotFire: true,
          params: {},
        },
        targets: ['https://app.example.test/other'],
        roles: ['anonymous', 'user'],
        refs: { owasp: ['A01'], wstg: ['WSTG-ATHN-03'], asvs: ['2.2.1'] },
        cweCandidates: ['CWE-287'],
      }),
    ]);
    const diff = diffPlans(from, to);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toHaveLength(1);
    const modified = diff.modified[0];
    expect(modified?.caseId).toBe(A);
    expect(modified?.title).toBe('Renamed');
    expect(modified?.changes).toEqual([
      { field: 'class', before: 'passive', after: 'active_safe' },
      { field: 'title', before: 'case ' + A, after: 'Renamed' },
      { field: 'status', before: 'proposed', after: 'approved' },
      {
        field: 'budget',
        before: { maxBytes: 1024, maxConcurrency: 1, maxRequests: 50, maxRps: 2 },
        after: { maxBytes: 1024, maxConcurrency: 1, maxRequests: 10, maxRps: 2 },
      },
      {
        field: 'oracle',
        before: { type: 'status_code', params: { expected: 429 } },
        after: { type: 'status_code', params: { expected: 403 } },
      },
      {
        field: 'negative_control',
        before: null,
        after: {
          kind: 'known_safe_endpoint',
          description: 'Same request to the public page',
          oracleMustNotFire: true,
          params: {},
        },
      },
      {
        field: 'targets',
        before: ['https://app.example.test/login'],
        after: ['https://app.example.test/other'],
      },
      { field: 'roles', before: ['anonymous'], after: ['anonymous', 'user'] },
      { field: 'owasp_refs', before: ['A07'], after: ['A01'] },
      { field: 'cwe_candidates', before: ['CWE-307'], after: ['CWE-287'] },
    ]);
  });

  it('treats a reordering of jsonb keys as no change', () => {
    const from = planOf(1, [
      caseOf(A, { budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 1, maxBytes: 1024 } }),
    ]);
    const to = planOf(2, [
      caseOf(A, { budget: { maxBytes: 1024, maxConcurrency: 1, maxRps: 2, maxRequests: 50 } }),
    ]);
    expect(diffPlans(from, to).modified).toEqual([]);
  });

  it('compares nested jsonb with sorted keys, so key order at every depth is noise', () => {
    const from = planOf(1, [
      caseOf(A, { oracle: { type: 'status_code', params: { a: { x: 1, y: 2 }, b: 3 } } }),
    ]);
    const to = planOf(2, [
      caseOf(A, { oracle: { type: 'status_code', params: { b: 3, a: { y: 2, x: 1 } } } }),
    ]);
    expect(diffPlans(from, to).modified).toEqual([]);
  });

  it('gives the same output however the cases are ordered, and sorts by caseId then title', () => {
    const cases = [caseOf(C, { title: 'b' }), caseOf(A), caseOf(D), caseOf(B, { title: 'z' })];
    const from = planOf(1, cases);
    const to = planOf(2, [caseOf(C, { title: 'b', status: 'approved' }), caseOf(D), caseOf(A)]);
    const reversed = planOf(2, [...to.cases].reverse());
    const first = diffPlans(from, to);
    const second = diffPlans(planOf(1, [...cases].reverse()), reversed);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.removed.map((ref) => ref.caseId)).toEqual([B]);
    expect(first.modified.map((modified) => modified.caseId)).toEqual([C]);
  });

  it('matches a re-created case by its title and targets when the caseId changed', () => {
    const from = planOf(1, [caseOf(A, { title: 'Login', status: 'proposed' })]);
    const to = planOf(2, [caseOf(B, { title: 'Login', status: 'approved' })]);
    const diff = diffPlans(from, to);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([
      {
        caseId: A,
        title: 'Login',
        changes: [{ field: 'status', before: 'proposed', after: 'approved' }],
      },
    ]);
  });

  it('reports a re-created case as remove and add when the fingerprint differs', () => {
    const from = planOf(1, [caseOf(A, { title: 'Login' })]);
    const to = planOf(2, [caseOf(B, { title: 'Logout' })]);
    const diff = diffPlans(from, to);
    expect(diff.removed).toEqual([{ caseId: A, title: 'Login' }]);
    expect(diff.added).toEqual([{ caseId: B, title: 'Logout' }]);
    expect(diff.modified).toEqual([]);
  });

  it('pairs fingerprint twins by caseId order, whatever the input order', () => {
    const from = planOf(1, [
      caseOf(B, { title: 'Login', status: 'proposed' }),
      caseOf(A, { title: 'Login', status: 'approved' }),
    ]);
    const to = planOf(2, [
      caseOf(D, { title: 'Login', status: 'proposed' }),
      caseOf(C, { title: 'Login', status: 'approved' }),
    ]);
    const first = diffPlans(from, to);
    const second = diffPlans(
      planOf(1, [...from.cases].reverse()),
      planOf(2, [...to.cases].reverse()),
    );
    expect(second).toEqual(first);
    expect(first.added).toEqual([]);
    expect(first.removed).toEqual([]);
    expect(first.modified).toEqual([]);
  });

  it('compares strings NFC-normalised, so composed and decomposed text is the same', () => {
    const composed = 'été';
    const decomposed = 'été'.normalize('NFD');
    const from = planOf(1, [caseOf(A, { title: decomposed })]);
    const to = planOf(2, [caseOf(A, { title: composed })]);
    expect(diffPlans(from, to).modified).toEqual([]);

    const renamed = planOf(3, [caseOf(A, { title: 'é' })]);
    const change = diffPlans(from, renamed).modified[0]?.changes[0];
    expect(change).toEqual({ field: 'title', before: composed, after: 'é' });
  });

  it('treats a null array and an empty array as equal (roles)', () => {
    const from = planOf(1, [caseOf(A, { roles: [] })]);
    const to = planOf(2, [caseOf(A, { roles: null as unknown as string[] })]);
    expect(diffPlans(from, to).modified).toEqual([]);
  });

  it('supports comparing non-adjacent versions', () => {
    const v1 = planOf(1, [caseOf(A)]);
    const v5 = planOf(5, [caseOf(A, { status: 'executed' }), caseOf(B)]);
    const diff = diffPlans(v1, v5);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(5);
    expect(diff.added).toEqual([{ caseId: B, title: `case ${B}` }]);
    expect(diff.modified[0]?.changes).toEqual([
      { field: 'status', before: 'proposed', after: 'executed' },
    ]);
  });

  it('diffs an empty version against a populated one', () => {
    const diff = diffPlans(planOf(1, []), planOf(2, [caseOf(A)]));
    expect(diff.added).toEqual([{ caseId: A, title: `case ${A}` }]);
    expect(diff.removed).toEqual([]);
  });

  it('handles a large plan in one pass', () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      caseOf(`0198f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`, { title: `t${i}` }),
    );
    const changed = many.map((testCase, i) =>
      i % 2 === 0 ? { ...testCase, status: 'approved' as const } : testCase,
    );
    const diff = diffPlans(planOf(1, many), planOf(2, changed));
    expect(diff.modified).toHaveLength(2500);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  describe('property: applying the changes to a rebuilds b', () => {
    const STATUSES = [...TEST_CASE_STATUSES];
    const word = fc.string({ maxLength: 6 });
    interface CaseValue {
      readonly class: TestCaseView['class'];
      readonly title: string;
      readonly status: TestCaseView['status'];
      readonly targets: string[];
      readonly roles: string[];
      readonly owasp: string[];
      readonly budget: { readonly maxRequests: number };
    }
    const caseArb: fc.Arbitrary<CaseValue> = fc.record({
      class: fc.constantFrom('passive', 'active_safe', 'state_changing'),
      title: word,
      status: fc.constantFrom(...STATUSES),
      targets: fc.array(word, { minLength: 1, maxLength: 2 }),
      roles: fc.array(word, { maxLength: 2 }),
      owasp: fc.array(word, { maxLength: 2 }),
      budget: fc.record({ maxRequests: fc.integer({ min: 1, max: 9 }) }),
    });
    const toCase = (caseId: string, value: CaseValue): TestCaseView =>
      caseOf(caseId, {
        class: value.class,
        title: value.title,
        status: value.status,
        targets: value.targets,
        roles: value.roles,
        refs: { owasp: value.owasp, wstg: [], asvs: [] },
        budget: {
          maxBytes: 1024,
          maxConcurrency: 1,
          maxRequests: value.budget.maxRequests,
          maxRps: 1,
        },
      });

    /** The fields a record carries, keyed by the diff field name. */
    function project(testCase: TestCaseView): Record<string, unknown> {
      return {
        class: testCase.class,
        title: testCase.title,
        status: testCase.status,
        budget: testCase.budget,
        oracle: testCase.oracle,
        negative_control: testCase.negativeControl,
        targets: testCase.targets,
        roles: testCase.roles,
        owasp_refs: testCase.refs.owasp,
        wstg_refs: testCase.refs.wstg,
        asvs_refs: testCase.refs.asvs,
        cwe_candidates: testCase.cweCandidates,
      };
    }

    /** JSON with object keys sorted at every depth, so two equal records serialise the same. */
    function stable(value: unknown): string {
      if (Array.isArray(value)) return `[${value.map((item: unknown) => stable(item)).join(',')}]`;
      if (value !== null && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    }

    /** Rebuilds version b from version a and the diff: drop removed, apply changes, add the added cases. */
    function rebuild(a: DiffablePlan, diff: ReturnType<typeof diffPlans>, b: DiffablePlan) {
      const removed = new Set(diff.removed.map((ref) => ref.caseId));
      const changes = new Map(diff.modified.map((modified) => [modified.caseId, modified.changes]));
      const byId = new Map(b.cases.map((testCase) => [testCase.caseId, testCase]));
      const rebuilt: string[] = [];
      for (const testCase of a.cases) {
        if (removed.has(testCase.caseId)) continue;
        const record = project(testCase);
        for (const change of changes.get(testCase.caseId) ?? []) {
          record[change.field] = change.after;
        }
        rebuilt.push(stable(record));
      }
      for (const ref of diff.added) {
        const added = byId.get(ref.caseId);
        if (added === undefined) throw new Error('added case missing from b');
        rebuilt.push(stable(project(added)));
      }
      return rebuilt.sort();
    }

    it('reconstructs b from a for random edits, and is order-independent', () => {
      fc.assert(
        fc.property(
          fc.uniqueArray(caseArb, { minLength: 0, maxLength: 8 }),
          fc.array(fc.record({ keep: fc.boolean(), next: caseArb }), { maxLength: 8 }),
          fc.array(caseArb, { maxLength: 4 }),
          (base, edits, extra) => {
            const aCases = base.map((value, i) => toCase(`c-${String(i)}`, value));
            const bCases: TestCaseView[] = [];
            edits.forEach((edit, i) => {
              if (i >= aCases.length || !edit.keep) return;
              bCases.push(toCase(`c-${String(i)}`, edit.next));
            });
            extra.forEach((value, i) => bCases.push(toCase(`n-${String(i)}`, value)));

            const a = planOf(1, aCases);
            const b = planOf(2, bCases);
            const diff = diffPlans(a, b);
            expect(rebuild(a, diff, b)).toEqual(bCases.map((c) => stable(project(c))).sort());

            const shuffled = diffPlans(
              planOf(1, [...aCases].reverse()),
              planOf(2, [...bCases].reverse()),
            );
            expect(JSON.stringify(shuffled)).toBe(JSON.stringify(diff));
          },
        ),
      );
    });
  });
});
