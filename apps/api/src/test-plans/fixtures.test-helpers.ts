import {
  ConcurrencyError,
  currentTenantId,
  type TestCasePatch,
  type TestCaseRemoval,
  type TestCaseWithPlan,
  type TestCaseWriteInput,
  type TestPlanCreate,
  type TestPlanRow,
  type TestPlanWithCases,
  type TestCaseRow,
} from '@blackwing/db';
import {
  EtagMismatchError,
  NotFoundError,
  PlanVersionImmutableError,
  TenantContextMissingError,
  TestCaseNotFoundError,
  TestPlanNotFoundError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import type { TestPlanMemberships, TestPlanStore } from './ports.js';
import type { PlannedTestCase } from '@blackwing/contracts';

export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
export const APPSEC_A = '0198f0a0-0000-7000-8000-0000000000a1';
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
export const APPSEC_B = '0198f0a0-0000-7000-8000-0000000000b1';
export const RUN_A = '0198f0a0-0000-7000-8000-0000000000e1';

const BASE_TIME = Date.parse('2026-10-01T10:00:00.000Z');
const STEP_MS = 1000;

/** A planned case that passes every API rule. Tests override the fields they exercise. */
export function plannedCase(overrides: Partial<PlannedTestCase> = {}): PlannedTestCase {
  return {
    class: 'passive',
    title: 'Login rate limit is enforced',
    refs: { owasp: ['A07'], wstg: ['WSTG-ATHN-03'], asvs: ['2.2.1'] },
    cweCandidates: ['CWE-307'],
    targets: ['https://app.example.test/login'],
    roles: ['anonymous'],
    budget: { maxRequests: 50, maxRps: 2, maxConcurrency: 1, maxBytes: 1_048_576 },
    oracle: { type: 'status_code', params: { expected: 429 } },
    negativeControl: null,
    ...overrides,
  };
}

/** An audit event the fake store recorded, as the Postgres hook would receive it. */
interface RecordedAudit {
  readonly action: string;
  readonly actorId: string;
  readonly caseId?: string;
  readonly planId?: string;
}

export interface MemoryTestPlanStore extends TestPlanStore {
  readonly audits: RecordedAudit[];
  /** Makes the next `createVersion` lose the race on `(run_id, version)` once. */
  failNextVersionWithConcurrency(): void;
  /** Seeds a run of a tenant so `createVersion` accepts it. */
  seedRun(runId: string, tenantId?: string): void;
  /** Sets a plan version's status (the approval flow lives in another issue). */
  setPlanStatus(planId: string, status: TestPlanRow['status']): void;
}

/**
 * The ambient tenant, as the Postgres adapter reads it. Every lookup is scoped to it, which is what RLS does:
 * another tenant's row is simply not found.
 */
function ambientTenant(): string {
  const tenantId = currentTenantId();
  if (tenantId === undefined || tenantId === '') {
    throw new TenantContextMissingError('no tenant context in the test store');
  }
  return tenantId;
}

/**
 * In-memory test plan store with the repository's contract: rows are scoped to the ambient tenant, a write checks
 * the plan is a draft, compares the `updated_at` it was given (ms precision), refuses destructive cases, and bumps
 * the plan's `updated_at` on every change to its cases.
 */
export function memoryTestPlanStore(): MemoryTestPlanStore {
  const runs = new Set<string>();
  const plans = new Map<string, TestPlanRow>();
  const cases = new Map<string, TestCaseRow>();
  const audits: RecordedAudit[] = [];
  let tick = 0;
  let concurrencyOnce = false;
  const now = () => {
    tick += 1;
    return new Date(BASE_TIME + tick * STEP_MS);
  };
  const refuseDestructive = (intrusiveness: string) => {
    if (intrusiveness === 'destructive') {
      throw new ValidationError('invalid test plan', {
        detail: 'A destructive test case cannot be planned.',
      });
    }
  };
  const ownPlan = (planId: string): TestPlanRow | undefined => {
    const plan = plans.get(planId);
    return plan?.tenantId === ambientTenant() ? plan : undefined;
  };
  const ownCase = (caseId: string): TestCaseRow | undefined => {
    const row = cases.get(caseId);
    return row?.tenantId === ambientTenant() ? row : undefined;
  };

  const casesOf = (planId: string): TestCaseRow[] =>
    [...cases.values()]
      .filter((c) => c.testPlanId === planId && c.tenantId === ambientTenant())
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  const withCases = (plan: TestPlanRow): TestPlanWithCases => ({ plan, cases: casesOf(plan.id) });
  const touch = (planId: string): TestPlanRow => {
    const plan = plans.get(planId);
    if (plan === undefined) throw new TestPlanNotFoundError();
    const next = { ...plan, updatedAt: now() };
    plans.set(planId, next);
    return next;
  };
  const assertDraft = (plan: TestPlanRow) => {
    if (plan.status !== 'draft') throw new PlanVersionImmutableError();
  };
  const assertVersion = (actual: Date, expected: Date) => {
    if (actual.getTime() !== expected.getTime()) throw new EtagMismatchError();
  };
  const liveCase = (caseId: string) => {
    const testCase = ownCase(caseId);
    if (testCase === undefined || testCase.status === 'removed') throw new TestCaseNotFoundError();
    const plan = ownPlan(testCase.testPlanId);
    if (plan === undefined) throw new TestCaseNotFoundError();
    return { testCase, plan };
  };
  const rowOf = (planId: string, planned: PlannedTestCase): TestCaseRow => {
    const at = now();
    return {
      id: newId(),
      tenantId: ambientTenant(),
      testPlanId: planId,
      class: planned.class,
      title: planned.title,
      owaspRefs: planned.refs.owasp,
      wstgRefs: planned.refs.wstg,
      asvsRefs: planned.refs.asvs,
      cweCandidates: planned.cweCandidates,
      targets: planned.targets,
      roles: planned.roles,
      budget: planned.budget,
      oracle: planned.oracle,
      negativeControl: planned.negativeControl,
      status: 'proposed',
      statusReason: null,
      createdAt: at,
      updatedAt: at,
    };
  };

  return {
    audits,
    failNextVersionWithConcurrency: () => {
      concurrencyOnce = true;
    },
    seedRun: (runId, tenantId = TENANT_A) => {
      runs.add(`${tenantId}:${runId}`);
    },
    setPlanStatus: (planId, status) => {
      const plan = plans.get(planId);
      if (plan !== undefined) plans.set(planId, { ...plan, status });
    },
    createVersion: (input: TestPlanCreate) => {
      const tenantId = ambientTenant();
      if (!runs.has(`${tenantId}:${input.runId}`)) {
        return Promise.reject(new NotFoundError('run not found'));
      }
      for (const planned of input.cases) refuseDestructive(planned.class);
      if (concurrencyOnce) {
        concurrencyOnce = false;
        return Promise.reject(new ConcurrencyError('test plan version'));
      }
      const versions = [...plans.values()].filter(
        (p) => p.runId === input.runId && p.tenantId === tenantId,
      );
      const version = Math.max(0, ...versions.map((p) => p.version)) + 1;
      const at = now();
      const plan = {
        id: newId(),
        tenantId,
        runId: input.runId,
        version,
        status: 'draft',
        createdBy: input.createdBy,
        createdAt: at,
        updatedAt: at,
      } as TestPlanRow;
      plans.set(plan.id, plan);
      const rows = input.cases.map((planned) => rowOf(plan.id, planned));
      for (const row of rows) cases.set(row.id, row);
      audits.push({
        action: 'test_plan.version_created',
        actorId: input.createdBy,
        planId: plan.id,
      });
      return Promise.resolve(withCases(plan));
    },
    findLatestVersion: (runId) => {
      const latest = [...plans.values()]
        .filter((p) => p.runId === runId && p.tenantId === ambientTenant())
        .sort((a, b) => b.version - a.version)[0];
      return Promise.resolve(latest === undefined ? undefined : withCases(latest));
    },
    findVersion: (runId, version) => {
      const found = [...plans.values()].find(
        (p) => p.runId === runId && p.version === version && p.tenantId === ambientTenant(),
      );
      return Promise.resolve(found === undefined ? undefined : withCases(found));
    },
    listVersions: (runId, options) =>
      Promise.resolve(
        [...plans.values()]
          .filter(
            (p) =>
              p.runId === runId &&
              p.tenantId === ambientTenant() &&
              (options.afterVersion ?? 0) < p.version,
          )
          .sort((a, b) => a.version - b.version)
          .slice(0, options.limit),
      ),
    findById: (planId) => {
      const plan = ownPlan(planId);
      return Promise.resolve(plan === undefined ? undefined : withCases(plan));
    },
    findCase: (caseId) => {
      const testCase = ownCase(caseId);
      const plan = testCase === undefined ? undefined : ownPlan(testCase.testPlanId);
      return Promise.resolve(
        testCase === undefined || plan === undefined ? undefined : { plan, testCase },
      );
    },
    addCase: (planId, input) => {
      const plan = ownPlan(planId);
      if (plan === undefined) return Promise.reject(new TestPlanNotFoundError());
      refuseDestructive(input.values.class);
      assertDraft(plan);
      assertVersion(plan.updatedAt, input.expectedUpdatedAt);
      const row = rowOf(planId, input.values);
      cases.set(row.id, row);
      const touched = touch(planId);
      audits.push({ action: 'test_case.created', actorId: input.actorId, caseId: row.id, planId });
      const result: TestCaseWithPlan = { plan: touched, testCase: row };
      return Promise.resolve(result);
    },
    updateCase: (caseId, input: TestCaseWriteInput & { readonly patch: TestCasePatch }) => {
      const { testCase, plan } = liveCase(caseId);
      refuseDestructive(input.patch.class ?? 'passive');
      assertDraft(plan);
      assertVersion(testCase.updatedAt, input.expectedUpdatedAt);
      const next = { ...testCase, ...toRowFields(input.patch), updatedAt: now() };
      cases.set(caseId, next);
      const touched = touch(plan.id);
      audits.push({
        action: 'test_case.updated',
        actorId: input.actorId,
        caseId,
        planId: plan.id,
      });
      return Promise.resolve({ plan: touched, testCase: next });
    },
    removeCase: (caseId, input: TestCaseWriteInput): Promise<TestCaseRemoval> => {
      const testCase = ownCase(caseId);
      const plan = testCase === undefined ? undefined : ownPlan(testCase.testPlanId);
      if (testCase === undefined || plan === undefined) {
        return Promise.reject(new TestCaseNotFoundError());
      }
      if (testCase.status === 'removed') {
        return Promise.resolve({ plan, testCase, changed: false });
      }
      assertDraft(plan);
      assertVersion(testCase.updatedAt, input.expectedUpdatedAt);
      const next = {
        ...testCase,
        status: 'removed',
        statusReason: 'removed from the test plan',
        updatedAt: now(),
      } as TestCaseRow;
      cases.set(caseId, next);
      const touched = touch(plan.id);
      audits.push({ action: 'test_case.removed', actorId: input.actorId, caseId, planId: plan.id });
      return Promise.resolve({ plan: touched, testCase: next, changed: true });
    },
  };
}

/** Maps the patch fields onto the stored columns (the same mapping as the repository). */
function toRowFields(patch: TestCasePatch): Partial<TestCaseRow> {
  const out: Record<string, unknown> = {};
  if (patch.class !== undefined) out.class = patch.class;
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.refs !== undefined) {
    out.owaspRefs = patch.refs.owasp;
    out.wstgRefs = patch.refs.wstg;
    out.asvsRefs = patch.refs.asvs;
  }
  if (patch.cweCandidates !== undefined) out.cweCandidates = patch.cweCandidates;
  if (patch.targets !== undefined) out.targets = patch.targets;
  if (patch.roles !== undefined) out.roles = patch.roles;
  if (patch.budget !== undefined) out.budget = patch.budget;
  if (patch.oracle !== undefined) out.oracle = patch.oracle;
  if (patch.negativeControl !== undefined) out.negativeControl = patch.negativeControl;
  return out;
}

/** Roles per (tenant, user). Anyone not listed holds no membership in that tenant. */
export function memoryMemberships(
  roles: Record<string, Record<string, readonly string[]>>,
): TestPlanMemberships {
  return {
    rolesOf: (tenantId, userId) => Promise.resolve(roles[tenantId]?.[userId] ?? []),
  };
}
