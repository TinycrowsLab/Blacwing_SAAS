import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import { hashTenantId } from '@blackwing/db/tenant-context';
import { TestPlanNotFoundError } from '@blackwing/errors';

import { rolesWithPermission, type TestPlanPrincipal } from '../authorise.js';
import {
  budgetTotals,
  type CaseFacts,
  gate1Required,
  planViolations,
  type PlanFacts,
  saIsActive,
  violation,
} from './rules.js';

import type { TestPlanMemberships } from '../ports.js';
import type { PlanValidationMetrics, PlanValidationOutcome } from './metrics.js';
import type { PlanPolicyEngine } from './policy.js';
import type { PlanValidationStore } from './ports.js';
import type { PlanValidationResult, PlanViolation } from '@blackwing/contracts';
import type { PlanValidationSnapshot } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/test-plans/validation';
const uuidSchema = z.uuid();

export interface PlanValidationServiceDeps {
  readonly store: PlanValidationStore;
  readonly memberships: TestPlanMemberships;
  readonly policy: PlanPolicyEngine;
  readonly metrics: PlanValidationMetrics;
  readonly logger: Pick<Logger, 'info'>;
  /** Clock of the validity check. Tests pass a fixed instant. */
  readonly clock?: () => Date;
  readonly tracer?: Tracer;
}

/**
 * Plan validation (PLAN-006, #396). `validatePlan` checks one plan version against the run's standing authorisation,
 * the Cedar plan policy and the run budgets, and answers with every violation. Reads need `testplan:read`. The
 * verdict is computed over one snapshot, so a concurrent edit cannot split it. Fail closed throughout: a missing SA is
 * `PLAN_SA_MISSING`, an inactive one `PLAN_SA_NOT_ACTIVE`, and a policy that cannot be evaluated is
 * `PLAN_POLICY_EVAL_FAILED`. Every completed validation writes one `test_plan.validated` audit event; if that write
 * fails, no verdict is returned.
 */
export class PlanValidationService {
  private readonly tracer: Tracer;
  private readonly clock: () => Date;

  constructor(private readonly deps: PlanValidationServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.clock = deps.clock ?? (() => new Date());
  }

  async validatePlan(principal: TestPlanPrincipal, planId: string): Promise<PlanValidationResult> {
    return this.tracer.startActiveSpan('plan.validate', async (span: Span) => {
      try {
        return await this.run(principal, planId, span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async run(
    principal: TestPlanPrincipal,
    planId: string,
    span: Span,
  ): Promise<PlanValidationResult> {
    const roles = await rolesWithPermission(this.deps.memberships, principal, 'testplan:read');
    const id = uuidSchema.safeParse(planId);
    if (!id.success) throw new TestPlanNotFoundError();
    span.setAttribute('planId', id.data);
    const snapshot = await this.deps.store.snapshot(principal.tenantId, id.data);
    if (snapshot === undefined) throw new TestPlanNotFoundError();

    let result: PlanValidationResult;
    try {
      result = this.evaluate(principal, roles, snapshot);
    } catch (error) {
      this.deps.metrics.validated('error');
      throw error;
    }
    try {
      await this.deps.store.recordValidated({
        action: 'test_plan.validated',
        tenantId: principal.tenantId,
        actorId: principal.actorId,
        planId: result.planId,
        runId: result.runId,
        version: result.version,
        saId: result.saId,
        ok: result.ok,
        violationCount: result.violations.length,
      });
    } catch (error) {
      this.deps.metrics.validated('error');
      throw error;
    }

    const outcome: PlanValidationOutcome = result.ok ? 'valid' : 'invalid';
    this.deps.metrics.validated(outcome);
    this.deps.metrics.violations(result);
    span.setAttribute('violationCount', result.violations.length);
    this.deps.logger.info(
      {
        tenantId: hashTenantId(principal.tenantId),
        planId: result.planId,
        saId: result.saId,
        violationCount: result.violations.length,
        ok: result.ok,
      },
      'test_plan.validated',
    );
    return result;
  }

  /** The verdict over one snapshot. Pure apart from the policy call, which fails closed on error. */
  private evaluate(
    principal: TestPlanPrincipal,
    roles: readonly string[],
    snapshot: PlanValidationSnapshot,
  ): PlanValidationResult {
    const { plan } = snapshot;
    const now = this.clock();
    const totals = budgetTotals(snapshot.cases);
    const base = {
      planId: plan.id,
      runId: plan.runId,
      version: plan.version,
      saId: snapshot.saId,
      budgetTotals: totals,
      validatedAt: now.toISOString(),
    };
    const sa = snapshot.authorisation;
    if (sa === undefined || snapshot.runBudgets === undefined) {
      return {
        ...base,
        ok: false,
        gate1Required: true,
        violations: [violation('PLAN_SA_MISSING', null)],
      };
    }

    const facts: PlanFacts = {
      cases: snapshot.cases.map((testCase): CaseFacts => ({
        id: testCase.id,
        class: testCase.class,
        targets: testCase.targets,
        roles: testCase.roles,
        budget: testCase.budget,
        oracle: testCase.oracle,
        negativeControl: testCase.negativeControl,
      })),
      sa,
      knownRoles: snapshot.knownRoles,
      runBudgets: snapshot.runBudgets,
    };
    const active = saIsActive(sa, now);
    const violations: PlanViolation[] = [
      ...(active ? [] : [violation('PLAN_SA_NOT_ACTIVE', null)]),
      ...planViolations(facts, totals),
      ...this.policyViolations(principal, roles, plan.id, plan.tenantId, active, facts),
    ];
    return {
      ...base,
      ok: violations.length === 0,
      gate1Required: gate1Required(facts),
      violations,
    };
  }

  /** The Cedar verdict as violations: one per determining policy, or one plain denial, or a fail-closed evaluation error. */
  private policyViolations(
    principal: TestPlanPrincipal,
    roles: readonly string[],
    planId: string,
    tenantId: string,
    saActive: boolean,
    facts: PlanFacts,
  ): PlanViolation[] {
    const cases = facts.cases;
    try {
      const decision = this.deps.policy.evaluate(
        { userId: principal.actorId, tenantId: principal.tenantId, roles },
        {
          tenantId,
          planId,
          saActive,
          destructiveCases: cases.filter((c) => c.class === 'destructive').length,
          stateChangingCases: cases.filter((c) => c.class === 'state_changing').length,
          stateChangingAuthorised: facts.sa.preApprovedTestClasses.includes('state_changing'),
        },
      );
      if (decision.decision === 'allow') return [];
      if (decision.policyIds.length === 0) return [violation('PLAN_POLICY_DENIED', null)];
      return decision.policyIds.map((policyId) => violation('PLAN_POLICY_DENIED', null, policyId));
    } catch {
      return [violation('PLAN_POLICY_EVAL_FAILED', null)];
    }
  }
}
