// Read model of plan validation (PLAN-006, #396, CONTEXT_PACK §8.1, §8.6). `snapshot` loads everything one validation
// needs in a single `withTenant` transaction, so the verdict is computed over one consistent view of the plan
// version, its cases, the run's standing authorisation and the asset role matrices. A plan of another tenant, or an
// unknown plan, reads as absent (RLS and the tenant predicate), so there is no existence leak. `recordValidated`
// writes the `test_plan.validated` audit event through the audit hook inside its own transaction (§8.8).

import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';

import { TenantContextMissingError } from '@blackwing/errors';

import { roleMatrices } from './schema/assets.js';
import { standingAuthorisations } from './schema/authorisation.js';
import { assessmentRequests } from './schema/scope.js';
import { testCases, testPlans } from './schema/test-plans.js';
import { withTenant, type TenantTx } from './with-tenant.js';

import type { Database } from './client.js';
import type { TestCaseRow, TestPlanRow } from './test-plans.repository.js';
import type { IntrusivenessClass } from '@blackwing/contracts';

/** The standing authorisation a plan is validated against (§7 `standing_authorisations`, the fields the validator reads). */
export interface PlanAuthorisation {
  readonly id: string;
  readonly status: 'draft' | 'pending_approval' | 'active' | 'expired' | 'revoked';
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly assetIds: readonly string[];
  readonly scopeRules: unknown;
  readonly maxIntrusiveness: IntrusivenessClass;
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: Readonly<Record<string, number>>;
}

/** Run budgets as the request stored them (`runBudgetSchema`): only the request cap bounds the cases here. */
export interface PlanRunBudgets {
  readonly maxRequests: number;
}

/**
 * Everything one validation reads, from one transaction. `knownRoles` is the role set every asset of the SA
 * agrees on (the intersection of their active role matrices), or null when an asset has no active matrix: then no
 * role is known and every case role is refused (fail closed).
 */
export interface PlanValidationSnapshot {
  readonly plan: TestPlanRow;
  /** The plan's non-removed cases, in creation order. */
  readonly cases: readonly TestCaseRow[];
  readonly saId: string | null;
  readonly runBudgets: PlanRunBudgets | undefined;
  readonly authorisation: PlanAuthorisation | undefined;
  readonly knownRoles: readonly string[] | null;
}

/** The `test_plan.validated` audit event. Metadata carries ids and counts only. */
export interface PlanValidatedAuditEvent {
  readonly action: 'test_plan.validated';
  readonly tenantId: string;
  readonly actorId: string;
  readonly planId: string;
  readonly runId: string;
  readonly version: number;
  readonly saId: string | null;
  readonly ok: boolean;
  readonly violationCount: number;
}

/** Writes the audit event inside the validation's audit transaction (§8.8). A failed append fails the call. */
export type PlanValidationAuditHook = (
  event: PlanValidatedAuditEvent,
  tx: TenantTx,
) => void | Promise<void>;

export interface PlanValidationRepositoryOptions {
  readonly db: Database;
  readonly audit: PlanValidationAuditHook;
}

/** A stored budget ceiling: each bound a number. A malformed stored value fails the read (fail closed). */
const budgetCeilingSchema = z.record(z.string(), z.number());
const runBudgetsSchema = z.looseObject({ maxRequests: z.number().int().min(0) });
const roleMatrixSchema = z.looseObject({ roles: z.array(z.string()) });

/** The roles one asset's active matrix declares, or an empty list when the matrix is malformed. */
function rolesOfMatrix(matrix: unknown): readonly string[] {
  const parsed = roleMatrixSchema.safeParse(matrix);
  return parsed.success ? parsed.data.roles : [];
}

export class PlanValidationRepository {
  private readonly options: PlanValidationRepositoryOptions;

  constructor(options: PlanValidationRepositoryOptions) {
    this.options = options;
  }

  /**
   * The validation snapshot of a plan in `tenantId`, or `undefined` when the plan is unknown or belongs to another
   * tenant. Non-removed cases only: a removed case is not part of the plan any more.
   */
  async snapshot(tenantId: string, planId: string): Promise<PlanValidationSnapshot | undefined> {
    if (tenantId === '') {
      throw new TenantContextMissingError('no tenant context: refusing to validate a test plan');
    }
    return withTenant(this.options.db, tenantId, async (tx) => {
      const planRows = await tx
        .select()
        .from(testPlans)
        .where(and(eq(testPlans.id, planId), eq(testPlans.tenantId, tenantId)))
        .limit(1);
      const plan = planRows[0];
      if (plan === undefined) return undefined;

      const cases = await tx
        .select()
        .from(testCases)
        .where(
          and(
            eq(testCases.testPlanId, plan.id),
            eq(testCases.tenantId, tenantId),
            ne(testCases.status, 'removed'),
          ),
        )
        .orderBy(asc(testCases.createdAt), asc(testCases.id));

      const requestRows = await tx
        .select({
          saId: assessmentRequests.saId,
          budgets: assessmentRequests.budgets,
        })
        .from(assessmentRequests)
        .where(
          and(eq(assessmentRequests.id, plan.runId), eq(assessmentRequests.tenantId, tenantId)),
        )
        .limit(1);
      const request = requestRows[0];
      const saId = request?.saId ?? null;
      const runBudgets =
        request === undefined ? undefined : runBudgetsSchema.parse(request.budgets);

      const authorisation =
        saId === null ? undefined : await this.authorisationOf(tx, tenantId, saId);
      const knownRoles =
        authorisation === undefined
          ? null
          : await this.knownRolesOf(tx, tenantId, authorisation.assetIds);

      return {
        plan,
        cases,
        saId,
        runBudgets,
        authorisation,
        knownRoles,
      } satisfies PlanValidationSnapshot;
    });
  }

  /** Appends the `test_plan.validated` audit event in its own transaction. */
  async recordValidated(event: PlanValidatedAuditEvent): Promise<void> {
    await withTenant(this.options.db, event.tenantId, async (tx) => {
      await this.options.audit(event, tx);
    });
  }

  private async authorisationOf(
    tx: TenantTx,
    tenantId: string,
    saId: string,
  ): Promise<PlanAuthorisation | undefined> {
    const rows = await tx
      .select()
      .from(standingAuthorisations)
      .where(
        and(eq(standingAuthorisations.id, saId), eq(standingAuthorisations.tenantId, tenantId)),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: row.id,
      status: row.status,
      validFrom: row.validFrom,
      expiresAt: row.expiresAt,
      assetIds: [...row.assetIds],
      scopeRules: row.scopeRules,
      maxIntrusiveness: row.maxIntrusiveness,
      preApprovedTestClasses: [...row.preApprovedTestClasses],
      defaultBudgets: budgetCeilingSchema.parse(row.defaultBudgets),
    };
  }

  /** Roles every asset of the SA declares in its active matrix; null when any asset has none (no role is known). */
  private async knownRolesOf(
    tx: TenantTx,
    tenantId: string,
    assetIds: readonly string[],
  ): Promise<readonly string[] | null> {
    if (assetIds.length === 0) return null;
    const rows = await tx
      .select({ assetId: roleMatrices.assetId, matrix: roleMatrices.matrix })
      .from(roleMatrices)
      .where(
        and(
          eq(roleMatrices.tenantId, tenantId),
          eq(roleMatrices.active, true),
          inArray(roleMatrices.assetId, [...assetIds]),
        ),
      );
    const byAsset = new Map(rows.map((row) => [row.assetId, rolesOfMatrix(row.matrix)]));
    if (assetIds.some((assetId) => !byAsset.has(assetId))) return null;
    const [first = [], ...rest] = assetIds.map((assetId) => byAsset.get(assetId) ?? []);
    return first.filter((role) => rest.every((roles) => roles.includes(role)));
  }
}
