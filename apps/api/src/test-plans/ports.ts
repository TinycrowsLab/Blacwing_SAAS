import type { PlannedTestCase } from '@blackwing/contracts';
import type {
  TestCasePatch,
  TestCaseRemoval,
  TestCaseWithPlan,
  TestCaseWriteInput,
  TestPlanCreate,
  TestPlanRow,
  TestPlanWithCases,
} from '@blackwing/db';

/**
 * Tenant-scoped test plan persistence. The Postgres adapter is `TestPlanRepository` in @blackwing/db: every call
 * runs in `withTenant`, RLS hides other tenants' rows, and each write audits itself in its own transaction.
 * Writes check their preconditions under a row lock (an `updated_at` compare-and-set) and refuse a non-draft
 * version, so the HTTP layer cannot race them.
 */
export interface TestPlanStore {
  createVersion(input: TestPlanCreate): Promise<TestPlanWithCases>;
  findLatestVersion(runId: string): Promise<TestPlanWithCases | undefined>;
  findVersion(runId: string, version: number): Promise<TestPlanWithCases | undefined>;
  listVersions(
    runId: string,
    options: { readonly afterVersion?: number; readonly limit: number },
  ): Promise<TestPlanRow[]>;
  findById(planId: string): Promise<TestPlanWithCases | undefined>;
  findCase(caseId: string): Promise<TestCaseWithPlan | undefined>;
  addCase(
    planId: string,
    input: TestCaseWriteInput & { readonly values: PlannedTestCase },
  ): Promise<TestCaseWithPlan>;
  updateCase(
    caseId: string,
    input: TestCaseWriteInput & { readonly patch: TestCasePatch },
  ): Promise<TestCaseWithPlan>;
  removeCase(caseId: string, input: TestCaseWriteInput): Promise<TestCaseRemoval>;
}

/** The roles a user holds in a tenant (RBAC-001). Empty means no permissions. */
export interface TestPlanMemberships {
  rolesOf(tenantId: string, userId: string): Promise<readonly string[]>;
}
