// Test-plan persistence (PLAN-001, CONTEXT_PACK §7, §8.3, §8.6, §8.8). A plan is versioned per run: each
// `createVersion` writes the next `version` and its proposed test cases in one transaction. Every method runs
// through `withTenant`, so RLS confines it and a missing tenant context fails closed. The unique
// `(run_id, version)` constraint is the race arbiter: a writer that loses it gets `ConcurrencyError` (412)
// and the API retries with the next version. Destructive cases are refused here, before any row is written
// (§8.3), and the CHECK constraints in the migration are the backstop.

import { and, asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';

import {
  MAX_PLAN_TEST_CASES,
  type PlannedTestCase,
  plannedTestCaseSchema,
  type TestPlanStatus,
} from '@blackwing/contracts';
import { NotFoundError, TenantContextMissingError, ValidationError } from '@blackwing/errors';
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
