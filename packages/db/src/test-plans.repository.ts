// Test-plan persistence (PLAN-001, CONTEXT_PACK §7, §8.3, §8.6, §8.8). A plan is versioned per run: each
// `createVersion` writes the next `version` and its proposed test cases in one transaction. Every method runs
// through `withTenant`, so RLS confines it and a missing tenant context fails closed. The unique
// `(run_id, version)` constraint is the race arbiter: a writer that loses it gets `ConcurrencyError` (412)
// and the API retries with the next version. Destructive cases are refused here, before any row is written
// (§8.3), and the CHECK constraints in the migration are the backstop.

import { and, asc, desc, eq, gt, max, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  MAX_PLAN_TEST_CASES,
  type PlannedTestCase,
  plannedTestCaseSchema,
  type TestPlanStatus,
} from '@blackwing/contracts';
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

import { ConcurrencyError, ForeignKeyError } from './repository.js';
import { toTenantIsolationError } from './rls.js';
import { runs } from './schema/runs.js';
import { testCases, testPlans } from './schema/test-plans.js';
import { currentTenantId } from './tenant-context.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { DbLogger } from './pool.js';

/** One row of `test_plans`. */
export type TestPlanRow = typeof testPlans.$inferSelect;
/** One row of `test_cases`. */
export type TestCaseRow = typeof testCases.$inferSelect;

/** A plan version with its cases, in case-id (creation) order. */
export interface TestPlanWithCases {
  readonly plan: TestPlanRow;
  readonly cases: readonly TestCaseRow[];
}

/**
 * A committed test plan write, for the audit ledger (§8.8). The hook runs inside the write's transaction, so a
 * failed audit append rolls the change back. Metadata carries ids, versions and changed field names only.
 */
export type TestPlanAuditEvent =
  | {
      readonly action: 'test_plan.version_created';
      readonly tenantId: string;
      readonly actorId: string;
      readonly planId: string;
      readonly runId: string;
      readonly version: number;
      readonly caseCount: number;
    }
  | {
      readonly action: 'test_case.created' | 'test_case.updated' | 'test_case.removed';
      readonly tenantId: string;
      readonly actorId: string;
      readonly planId: string;
      readonly caseId: string;
      readonly changedFields: readonly string[];
    };
export type TestPlanAuditHook = (event: TestPlanAuditEvent, tx: TenantTx) => void | Promise<void>;

/** `createVersion` input. The tenant is never accepted here: it is the ambient tenant of the call. */
const createSchema = z.strictObject({
  runId: z.uuid(),
  createdBy: z.uuid(),
  cases: z.array(plannedTestCaseSchema).max(MAX_PLAN_TEST_CASES),
});
export type TestPlanCreate = z.input<typeof createSchema>;

const idSchema = z.uuid();

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

/** The statuses a plan version starts in (see `TEST_PLAN_STATUSES`). */
const INITIAL_PLAN_STATUS: TestPlanStatus = 'draft';

export interface TestPlanRepositoryOptions {
  readonly db: Database;
  readonly logger?: Pick<DbLogger, 'info'>;
  /** Ambient tenant source; defaults to the AsyncLocalStorage context (TENANT-003). Tests and tools pass one. */
  readonly tenant?: () => string | undefined;
  /** Audit hook (§8.8) run inside every write's transaction: a failed append rolls the write back. */
  readonly audit: TestPlanAuditHook;
}

/** A case with the plan version it belongs to (the case may be removed). */
export interface TestCaseWithPlan {
  readonly plan: TestPlanRow;
  readonly testCase: TestCaseRow;
}

/** The result of a case removal: `changed` is false when the case was already removed (a no-op). */
export interface TestCaseRemoval extends TestCaseWithPlan {
  readonly changed: boolean;
}

/** `addCase` / `updateCase` / `removeCase` input. `expectedUpdatedAt` is the version the caller validated. */
export interface TestCaseWriteInput {
  readonly actorId: string;
  readonly expectedUpdatedAt: Date;
}

/** Fields a PATCH may change: the planned-case fields, each optional. */
export type TestCasePatch = {
  readonly [K in keyof PlannedTestCase]?: PlannedTestCase[K] | undefined;
};

/** Reason stored with a soft-removed case (`TEST_CASE_STATUSES_WITH_REASON`). */
const REMOVED_REASON = 'removed from the test plan';
/** A `draft` version is the only one still editable. Every later state is immutable (PLAN_VERSION_IMMUTABLE). */
const EDITABLE_PLAN_STATUS: TestPlanStatus = 'draft';

/** Column values of a planned case, keyed by the PATCH field that sets them. */
function caseColumns(patch: TestCasePatch) {
  const set: Partial<typeof testCases.$inferInsert> = {};
  if (patch.class !== undefined) set.class = patch.class;
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.refs !== undefined) {
    set.owaspRefs = patch.refs.owasp;
    set.wstgRefs = patch.refs.wstg;
    set.asvsRefs = patch.refs.asvs;
  }
  if (patch.cweCandidates !== undefined) set.cweCandidates = patch.cweCandidates;
  if (patch.targets !== undefined) set.targets = patch.targets;
  if (patch.roles !== undefined) set.roles = patch.roles;
  if (patch.budget !== undefined) set.budget = patch.budget;
  if (patch.oracle !== undefined) set.oracle = patch.oracle;
  if (patch.negativeControl !== undefined) set.negativeControl = patch.negativeControl;
  return set;
}

/** Names of the fields a patch sets, for the audit metadata (never their values). */
function changedFieldNames(patch: TestCasePatch): string[] {
  return Object.keys(patch).sort();
}

function parseInput<V>(schema: z.ZodType<V>, value: unknown, what: string): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Field paths only: issue messages can echo input values.
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError(`invalid ${what}`, {
      detail: `Invalid ${what}: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return result.data;
}

/** Converts a planner case into the row values. */
function caseValues(planned: PlannedTestCase, planId: string, tenantId: string) {
  return {
    id: newId(),
    tenantId,
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
    status: 'proposed' as const,
    statusReason: null,
  };
}

/**
 * Tenant-scoped persistence of test plans and their cases. Thin on purpose: the plan editor API (PLAN-005)
 * owns edits and the approval flow, and validation (PLAN-006) owns the oracle checks.
 */
export class TestPlanRepository {
  private readonly options: TestPlanRepositoryOptions;

  constructor(options: TestPlanRepositoryOptions) {
    this.options = options;
  }

  /**
   * Writes the next version of a run's plan (`max(version) + 1`) with its proposed cases. An unknown run, or one
   * of another tenant (RLS hides it), is `NotFoundError`. A lost race on `(run_id, version)` is `ConcurrencyError`.
   */
  async createVersion(input: unknown): Promise<TestPlanWithCases> {
    const values = parseInput(createSchema, input, 'test plan');
    // Refused before any transaction: a destructive case is never planned, not even as a draft (§8.3).
    if (values.cases.some((planned) => planned.class === 'destructive')) {
      throw new ValidationError('invalid test plan', {
        detail: 'A destructive test case cannot be planned (CONTEXT_PACK §8.3).',
      });
    }
    const runId = values.runId;
    const result = await this.run('createVersion', async (tx, tenantId) => {
      const [run] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
        .limit(1);
      if (run === undefined) throw new NotFoundError('run not found');

      const [latest] = await tx
        .select({ version: max(testPlans.version) })
        .from(testPlans)
        .where(and(eq(testPlans.runId, runId), eq(testPlans.tenantId, tenantId)));
      const version = (latest?.version ?? 0) + 1;

      const planId = newId();
      const [plan] = await tx
        .insert(testPlans)
        .values({
          id: planId,
          tenantId,
          runId,
          version,
          status: INITIAL_PLAN_STATUS,
          createdBy: values.createdBy,
        })
        .returning();
      if (plan === undefined) throw new Error('test plan insert returned no row');

      const rows = values.cases.map((planned) => caseValues(planned, planId, tenantId));
      const cases = rows.length === 0 ? [] : await tx.insert(testCases).values(rows).returning();
      cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      await this.emit(
        {
          action: 'test_plan.version_created',
          tenantId,
          actorId: values.createdBy,
          planId,
          runId,
          version,
          caseCount: cases.length,
        },
        tx,
      );
      return { row: { plan, cases }, rowCount: 1 + cases.length };
    });
    this.afterCommit('createVersion', result.plan, result.cases.length);
    return result;
  }

  /** One plan version with its cases, or `undefined` (also for another tenant's plan). */
  async findById(id: string): Promise<TestPlanWithCases | undefined> {
    const planId = parseInput(idSchema, id, 'id');
    return this.run('findById', async (tx, tenantId) => {
      const [plan] = await tx
        .select()
        .from(testPlans)
        .where(and(eq(testPlans.id, planId), eq(testPlans.tenantId, tenantId)))
        .limit(1);
      if (plan === undefined) return { row: undefined, rowCount: 0 };
      const cases = await tx
        .select()
        .from(testCases)
        .where(and(eq(testCases.testPlanId, planId), eq(testCases.tenantId, tenantId)))
        .orderBy(asc(testCases.id));
      return { row: { plan, cases }, rowCount: 1 + cases.length };
    });
  }

  /** Every plan version of a run, oldest first. An unknown run yields an empty list. */
  async listForRun(runId: string): Promise<TestPlanRow[]> {
    const rid = parseInput(idSchema, runId, 'runId');
    return this.run('listForRun', async (tx, tenantId) => {
      const rows = await tx
        .select()
        .from(testPlans)
        .where(and(eq(testPlans.runId, rid), eq(testPlans.tenantId, tenantId)))
        .orderBy(asc(testPlans.version));
      return { row: rows, rowCount: rows.length };
    });
  }

  /** Runs `fn` in the ambient tenant's transaction, translating database errors into the typed set. */
  /** The newest version of a run with its cases, or `undefined` when the run has no plan yet. */
  async findLatestVersion(runId: string): Promise<TestPlanWithCases | undefined> {
    const rid = parseInput(idSchema, runId, 'runId');
    return this.run('findLatestVersion', async (tx, tenantId) => {
      const [plan] = await tx
        .select()
        .from(testPlans)
        .where(and(eq(testPlans.runId, rid), eq(testPlans.tenantId, tenantId)))
        .orderBy(desc(testPlans.version))
        .limit(1);
      if (plan === undefined) return { row: undefined, rowCount: 0 };
      const cases = await tx
        .select()
        .from(testCases)
        .where(and(eq(testCases.testPlanId, plan.id), eq(testCases.tenantId, tenantId)))
        .orderBy(asc(testCases.id));
      return { row: { plan, cases }, rowCount: 1 + cases.length };
    });
  }

  /** Lists the versions of a run, oldest first, after `afterVersion` (keyset on the version number). */
  async listVersions(
    runId: string,
    options: { readonly afterVersion?: number; readonly limit: number },
  ): Promise<TestPlanRow[]> {
    const rid = parseInput(idSchema, runId, 'runId');
    return this.run('listVersions', async (tx, tenantId) => {
      const after = options.afterVersion;
      const rows = await tx
        .select()
        .from(testPlans)
        .where(
          and(
            eq(testPlans.runId, rid),
            eq(testPlans.tenantId, tenantId),
            after === undefined ? undefined : gt(testPlans.version, after),
          ),
        )
        .orderBy(asc(testPlans.version))
        .limit(options.limit);
      return { row: rows, rowCount: rows.length };
    });
  }

  /** One plan version of a run with its cases, or `undefined` (also for another tenant's run). */
  async findVersion(runId: string, version: number): Promise<TestPlanWithCases | undefined> {
    const rid = parseInput(idSchema, runId, 'runId');
    return this.run('findVersion', async (tx, tenantId) => {
      const [plan] = await tx
        .select()
        .from(testPlans)
        .where(
          and(
            eq(testPlans.runId, rid),
            eq(testPlans.version, version),
            eq(testPlans.tenantId, tenantId),
          ),
        )
        .limit(1);
      if (plan === undefined) return { row: undefined, rowCount: 0 };
      const cases = await tx
        .select()
        .from(testCases)
        .where(and(eq(testCases.testPlanId, plan.id), eq(testCases.tenantId, tenantId)))
        .orderBy(asc(testCases.id));
      return { row: { plan, cases }, rowCount: 1 + cases.length };
    });
  }

  /** A test case (removed or not) with its plan version, or `undefined` (also for another tenant's case). */
  async findCase(caseId: string): Promise<TestCaseWithPlan | undefined> {
    const cid = parseInput(idSchema, caseId, 'caseId');
    return this.run('findCase', async (tx, tenantId) => {
      const [row] = await tx
        .select({ testCase: testCases, plan: testPlans })
        .from(testCases)
        .innerJoin(
          testPlans,
          and(eq(testPlans.id, testCases.testPlanId), eq(testPlans.tenantId, testCases.tenantId)),
        )
        .where(and(eq(testCases.id, cid), eq(testCases.tenantId, tenantId)))
        .limit(1);
      return { row, rowCount: row === undefined ? 0 : 1 };
    });
  }

  /**
   * Adds a case to a `draft` plan version. The plan row is locked; a non-draft version is refused
   * (`PLAN_VERSION_IMMUTABLE`) and a plan whose `updated_at` is not `expectedUpdatedAt` is `EtagMismatchError`.
   * The plan's `updated_at` is bumped so its ETag moves with its contents.
   */
  async addCase(planId: string, input: TestCaseWriteInput & { readonly values: PlannedTestCase }) {
    const pid = parseInput(idSchema, planId, 'planId');
    const values = parseInput(plannedTestCaseSchema, input.values, 'test case');
    refuseDestructive(values.class);
    return this.run('addCase', async (tx, tenantId) => {
      await lockPlan(tx, tenantId, pid, input.expectedUpdatedAt);
      const [testCase] = await tx
        .insert(testCases)
        .values(caseValues(values, pid, tenantId))
        .returning();
      if (testCase === undefined) throw new Error('test case insert returned no row');
      const touched = await touchPlan(tx, tenantId, pid);
      await this.emit(
        {
          action: 'test_case.created',
          tenantId,
          actorId: input.actorId,
          planId: pid,
          caseId: testCase.id,
          changedFields: changedFieldNames(values),
        },
        tx,
      );
      return { row: { plan: touched, testCase }, rowCount: 2 };
    });
  }

  /**
   * Edits a case of a `draft` plan version. A removed case is `TestCaseNotFoundError`. The case row is locked and
   * its `updated_at` must equal `expectedUpdatedAt` (else `EtagMismatchError`); the write is one compare-and-set.
   */
  async updateCase(caseId: string, input: TestCaseWriteInput & { readonly patch: TestCasePatch }) {
    const cid = parseInput(idSchema, caseId, 'caseId');
    const patch = parseInput(plannedTestCaseSchema.partial(), input.patch, 'test case patch');
    refuseDestructive(patch.class);
    return this.run('updateCase', async (tx, tenantId) => {
      const current = await lockCase(tx, tenantId, cid);
      if (current === undefined || current.testCase.status === 'removed') {
        throw new TestCaseNotFoundError();
      }
      assertDraft(current.plan);
      assertSameVersion(current.testCase.updatedAt, input.expectedUpdatedAt);
      const [testCase] = await tx
        .update(testCases)
        .set(caseColumns(patch))
        .where(and(eq(testCases.id, cid), eq(testCases.tenantId, tenantId)))
        .returning();
      if (testCase === undefined) throw new TestCaseNotFoundError();
      const touched = await touchPlan(tx, tenantId, current.plan.id);
      await this.emit(
        {
          action: 'test_case.updated',
          tenantId,
          actorId: input.actorId,
          planId: current.plan.id,
          caseId: cid,
          changedFields: changedFieldNames(patch),
        },
        tx,
      );
      return { row: { plan: touched, testCase }, rowCount: 2 };
    });
  }

  /**
   * Soft-removes a case (`status = removed`, rows are never deleted). Removing an already removed case is a
   * no-op with `changed: false` and no audit event (idempotent). Otherwise the `updated_at` check applies.
   */
  async removeCase(caseId: string, input: TestCaseWriteInput): Promise<TestCaseRemoval> {
    const cid = parseInput(idSchema, caseId, 'caseId');
    return this.run<TestCaseRemoval>('removeCase', async (tx, tenantId) => {
      const current = await lockCase(tx, tenantId, cid);
      if (current === undefined) throw new TestCaseNotFoundError();
      if (current.testCase.status === 'removed') {
        return { row: { ...current, changed: false }, rowCount: 0 };
      }
      assertDraft(current.plan);
      assertSameVersion(current.testCase.updatedAt, input.expectedUpdatedAt);
      const [testCase] = await tx
        .update(testCases)
        .set({ status: 'removed', statusReason: REMOVED_REASON })
        .where(and(eq(testCases.id, cid), eq(testCases.tenantId, tenantId)))
        .returning();
      if (testCase === undefined) throw new TestCaseNotFoundError();
      const touched = await touchPlan(tx, tenantId, current.plan.id);
      await this.emit(
        {
          action: 'test_case.removed',
          tenantId,
          actorId: input.actorId,
          planId: current.plan.id,
          caseId: cid,
          changedFields: ['status'],
        },
        tx,
      );
      return { row: { plan: touched, testCase, changed: true }, rowCount: 2 };
    });
  }

  /** Runs the audit hook inside the write's transaction. */
  private async emit(event: TestPlanAuditEvent, tx: TenantTx): Promise<void> {
    await this.options.audit(event, tx);
  }

  private async run<R>(
    op: string,
    fn: (tx: TenantTx, tenantId: string) => Promise<{ row: R; rowCount: number }>,
  ): Promise<R> {
    const tenantId = this.tenantId();
    try {
      const { row, rowCount } = await withTenant(this.options.db, tenantId, (tx) =>
        fn(tx, tenantId),
      );
      this.options.logger?.info({ entity: 'test_plan', op, tenantId, rowCount }, 'db.repo');
      return row;
    } catch (error) {
      throw translate(error);
    }
  }

  private tenantId(): string {
    const tenantId = (this.options.tenant ?? currentTenantId)();
    if (tenantId === undefined || tenantId === '') {
      throw new TenantContextMissingError('no tenant context: refusing to run a test plan query');
    }
    return tenantId;
  }

  /** Log line after the transaction committed (a rolled-back write is not logged as written). */
  private afterCommit(op: 'createVersion', plan: TestPlanRow, caseCount: number): void {
    this.options.logger?.info(
      {
        op,
        tenantId: plan.tenantId,
        testPlanId: plan.id,
        version: plan.version,
        caseCount,
      },
      'test_plan',
    );
  }
}

/** A destructive case is never planned or edited into a plan (§8.3); the CHECK constraint is the backstop. */
function refuseDestructive(intrusiveness: PlannedTestCase['class'] | undefined): void {
  if (intrusiveness === 'destructive') {
    throw new ValidationError('invalid test plan', {
      detail: 'A destructive test case cannot be planned (CONTEXT_PACK §8.3).',
    });
  }
}

/** Locks a plan row (`FOR UPDATE`), then checks it is a draft at the version the caller validated. */
async function lockPlan(tx: TenantTx, tenantId: string, planId: string, expected: Date) {
  const [plan] = await tx
    .select()
    .from(testPlans)
    .where(and(eq(testPlans.id, planId), eq(testPlans.tenantId, tenantId)))
    .limit(1)
    .for('update');
  if (plan === undefined) throw new TestPlanNotFoundError();
  assertDraft(plan);
  assertSameVersion(plan.updatedAt, expected);
  return plan;
}

/** Locks a case and its plan (`FOR UPDATE`); `undefined` when the case is not in the caller's tenant. */
async function lockCase(
  tx: TenantTx,
  tenantId: string,
  caseId: string,
): Promise<TestCaseWithPlan | undefined> {
  const [row] = await tx
    .select({ testCase: testCases, plan: testPlans })
    .from(testCases)
    .innerJoin(
      testPlans,
      and(eq(testPlans.id, testCases.testPlanId), eq(testPlans.tenantId, testCases.tenantId)),
    )
    .where(and(eq(testCases.id, caseId), eq(testCases.tenantId, tenantId)))
    .limit(1)
    .for('update', { of: testCases });
  return row;
}

/** Bumps the plan's `updated_at` (its ETag) after a change to its cases, and returns the plan row. */
async function touchPlan(tx: TenantTx, tenantId: string, planId: string): Promise<TestPlanRow> {
  const [plan] = await tx
    .update(testPlans)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(testPlans.id, planId), eq(testPlans.tenantId, tenantId)))
    .returning();
  if (plan === undefined) throw new TestPlanNotFoundError();
  return plan;
}

function assertDraft(plan: TestPlanRow): void {
  if (plan.status !== EDITABLE_PLAN_STATUS) throw new PlanVersionImmutableError();
}

/** Compare-and-set on the version: the caller's ETag must name the row as it is under the lock. */
function assertSameVersion(actual: Date, expected: Date): void {
  if (actual.getTime() !== expected.getTime()) throw new EtagMismatchError();
}

/** Maps a Postgres error to the typed error set: a unique violation is a lost version race (retry). */
function translate(error: unknown): unknown {
  const pgError = unwrapQueryError(error) as { code?: unknown; constraint?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConcurrencyError('test plan version', { cause: error });
  }
  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    return new ForeignKeyError(
      'test_plan',
      typeof pgError.constraint === 'string' ? pgError.constraint : undefined,
      { cause: error },
    );
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid test plan', {
      detail: 'A database check rejected the test plan.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
