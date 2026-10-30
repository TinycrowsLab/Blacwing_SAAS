import {
  PLAN_DIFF_FIELDS,
  type ModifiedCase,
  type PlanDiff,
  type PlanFieldChange,
  type TestCaseRef,
  type TestCaseView,
} from '@blackwing/contracts';

/**
 * Plan-version diff (PLAN-002). Pure: no IO, no clock, so the same function serves the API, the Gate 1 review
 * and the browser plan editor. Cases are matched by a carried-over `caseId` first, then by a content
 * fingerprint (title and targets) for the cases a version re-created. Comparison is canonical: strings are
 * NFC-normalised, object keys are sorted (jsonb key order is noise), and a null array equals an empty one.
 */

/** The plan fields the diff reads: a version number and its cases. `TestPlanView` satisfies it. */
export interface DiffablePlan {
  readonly version: number;
  readonly cases: readonly TestCaseView[];
}

type PlanDiffField = (typeof PLAN_DIFF_FIELDS)[number];
type CanonicalValue = PlanFieldChange['before'];

/** Fields that are arrays: a null value is read as an empty array, so the two compare equal. */
const ARRAY_FIELDS: ReadonlySet<PlanDiffField> = new Set([
  'targets',
  'roles',
  'owasp_refs',
  'wstg_refs',
  'asvs_refs',
  'cwe_candidates',
]);

const FIELD_VALUE: Record<PlanDiffField, (testCase: TestCaseView) => unknown> = {
  class: (c) => c.class,
  title: (c) => c.title,
  status: (c) => c.status,
  budget: (c) => c.budget,
  oracle: (c) => c.oracle,
  negative_control: (c) => c.negativeControl,
  targets: (c) => c.targets,
  roles: (c) => c.roles,
  owasp_refs: (c) => c.refs.owasp,
  wstg_refs: (c) => c.refs.wstg,
  asvs_refs: (c) => c.refs.asvs,
  cwe_candidates: (c) => c.cweCandidates,
};

/** Canonical JSON: NFC strings and object keys, object keys sorted, `undefined` read as null. */
function canonical(value: unknown): CanonicalValue {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map((item: unknown) => canonical(item));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(record).sort()) {
      out[key.normalize('NFC')] = canonical(record[key]);
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/** The canonical value of one field of a case. */
function fieldOf(testCase: TestCaseView, field: PlanDiffField): CanonicalValue {
  const value = FIELD_VALUE[field](testCase) ?? null;
  return canonical(value === null && ARRAY_FIELDS.has(field) ? [] : value);
}

/** Canonical JSON text, so two values compare equal exactly when their canonical forms do. */
function key(value: CanonicalValue): string {
  return JSON.stringify(value);
}

/** Two cases are the same case when their titles and targets match (NFC, canonical). */
function fingerprint(testCase: TestCaseView): string {
  return key([fieldOf(testCase, 'title'), fieldOf(testCase, 'targets')]);
}

/** Code-unit order: locale-free, so the output is byte-identical on every machine. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Orders cases by `caseId`, then `title`. */
function byIdentity(a: { caseId: string; title: string }, b: { caseId: string; title: string }) {
  return compareStrings(a.caseId, b.caseId) || compareStrings(a.title, b.title);
}

/** The field changes between two matched cases, in `PLAN_DIFF_FIELDS` order. */
function changesBetween(before: TestCaseView, after: TestCaseView): PlanFieldChange[] {
  const changes: PlanFieldChange[] = [];
  for (const field of PLAN_DIFF_FIELDS) {
    const previous = fieldOf(before, field);
    const next = fieldOf(after, field);
    if (key(previous) !== key(next)) changes.push({ field, before: previous, after: next });
  }
  return changes;
}

/**
 * Pairs the cases of two versions. First by `caseId`; then, for what is left, by fingerprint, in `caseId`
 * order, so the pairing does not depend on the order the cases arrived in.
 */
function pairCases(
  from: readonly TestCaseView[],
  to: readonly TestCaseView[],
): { pairs: [TestCaseView, TestCaseView][]; removed: TestCaseView[]; added: TestCaseView[] } {
  const toById = new Map(to.map((testCase) => [testCase.caseId, testCase]));
  const pairs: [TestCaseView, TestCaseView][] = [];
  const pairedFrom = new Set<string>();
  const pairedTo = new Set<string>();

  for (const testCase of from) {
    const counterpart = toById.get(testCase.caseId);
    if (counterpart === undefined) continue;
    pairs.push([testCase, counterpart]);
    pairedFrom.add(testCase.caseId);
    pairedTo.add(counterpart.caseId);
  }

  const unpairedTo = new Map<string, TestCaseView[]>();
  for (const testCase of to) {
    if (pairedTo.has(testCase.caseId)) continue;
    const print = fingerprint(testCase);
    unpairedTo.set(print, [...(unpairedTo.get(print) ?? []), testCase]);
  }
  for (const testCase of from) {
    if (pairedFrom.has(testCase.caseId)) continue;
    const counterpart = unpairedTo.get(fingerprint(testCase))?.shift();
    if (counterpart === undefined) continue;
    pairs.push([testCase, counterpart]);
    pairedFrom.add(testCase.caseId);
    pairedTo.add(counterpart.caseId);
  }

  return {
    pairs,
    removed: from.filter((testCase) => !pairedFrom.has(testCase.caseId)),
    added: to.filter((testCase) => !pairedTo.has(testCase.caseId)),
  };
}

function refOf(testCase: TestCaseView): TestCaseRef {
  return { caseId: testCase.caseId, title: testCase.title };
}

/**
 * What changed from `a` to `b`. `diffPlans(v, v)` is empty, and the output is the same for the same inputs
 * however the cases are ordered. Every list is sorted by `caseId`, then `title`.
 */
export function diffPlans(a: DiffablePlan, b: DiffablePlan): PlanDiff {
  const sortedFrom = [...a.cases].sort(byIdentity);
  const sortedTo = [...b.cases].sort(byIdentity);
  const { pairs, removed, added } = pairCases(sortedFrom, sortedTo);

  const modified: ModifiedCase[] = [];
  for (const [before, after] of pairs) {
    const changes = changesBetween(before, after);
    if (changes.length > 0) {
      modified.push({ caseId: before.caseId, title: after.title, changes });
    }
  }

  return {
    fromVersion: a.version,
    toVersion: b.version,
    added: added.map((testCase) => refOf(testCase)).sort(byIdentity),
    removed: removed.map((testCase) => refOf(testCase)).sort(byIdentity),
    modified: modified.sort(byIdentity),
  };
}
