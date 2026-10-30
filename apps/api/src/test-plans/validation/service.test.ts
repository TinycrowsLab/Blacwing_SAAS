import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import {
  APPSEC_A,
  APPSEC_B,
  AUDITOR_A,
  memoryMemberships,
  TENANT_A,
  TENANT_B,
} from '../fixtures.test-helpers.js';
import {
  activeAuthorisation,
  CASE_ID,
  caseRow,
  memoryPlanValidationStore,
  NOW,
  SA_ID,
  validSnapshot,
  type MemoryPlanValidationStore,
} from './fixtures.test-helpers.js';
import { createPlanValidationMetrics, type PlanValidationMetrics } from './metrics.js';
import { createCedarPlanPolicy, type PlanPolicyEngine } from './policy.js';
import { PlanValidationService } from './service.js';

import type { PlanValidationResult } from '@blackwing/contracts';
import type { PlanValidationSnapshot } from '@blackwing/db';

const APPSEC = { tenantId: TENANT_A, actorId: APPSEC_A };
const MEMBERSHIPS = memoryMemberships({
  [TENANT_A]: { [APPSEC_A]: ['appsec_engineer'], [AUDITOR_A]: ['auditor'] },
  [TENANT_B]: { [APPSEC_B]: ['appsec_engineer'] },
});

interface Harness {
  readonly service: PlanValidationService;
  readonly store: MemoryPlanValidationStore;
  readonly outcomes: string[];
  readonly codes: string[];
}

/** A service over the in-memory store, the real Cedar plan policy and a recording metrics sink. */
function harness(options: { policy?: PlanPolicyEngine; clock?: () => Date } = {}): Harness {
  const store = memoryPlanValidationStore();
  const outcomes: string[] = [];
  const codes: string[] = [];
  const recording: PlanValidationMetrics = {
    validated: (result) => {
      outcomes.push(result);
    },
    violations: (result: PlanValidationResult) => {
      for (const v of result.violations) codes.push(v.code);
    },
  };
  const service = new PlanValidationService({
    store,
    memberships: MEMBERSHIPS,
    policy: options.policy ?? createCedarPlanPolicy(),
    metrics: recording,
    logger: { info: () => undefined },
    clock: options.clock ?? (() => NOW),
  });
  return { service, store, outcomes, codes };
}

/** Seeds a snapshot of the default tenant and returns the plan id. */
function seed(
  store: MemoryPlanValidationStore,
  snapshot: PlanValidationSnapshot = validSnapshot(),
) {
  store.seed(snapshot);
  return snapshot.plan.id;
}

describe('PlanValidationService.validatePlan', () => {
  it('answers ok for a valid plan, with budget totals, and audits the verdict', async () => {
    const h = harness();
    const planId = seed(h.store);
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result).toMatchObject({
      planId,
      runId: validSnapshot().plan.runId,
      version: 1,
      saId: SA_ID,
      ok: true,
      gate1Required: true,
      violations: [],
      budgetTotals: {
        totalRequests: 50,
        totalBytes: 100_000,
        perClassCounts: { passive: 0, active_safe: 1, state_changing: 0, destructive: 0 },
      },
      validatedAt: NOW.toISOString(),
    });
    expect(h.store.events).toEqual([
      {
        action: 'test_plan.validated',
        tenantId: TENANT_A,
        actorId: APPSEC_A,
        planId,
        runId: validSnapshot().plan.runId,
        version: 1,
        saId: SA_ID,
        ok: true,
        violationCount: 0,
      },
    ]);
    expect(h.outcomes).toEqual(['valid']);
  });

  it('refuses a caller with no test-plan read permission (no membership)', async () => {
    const h = harness();
    const planId = seed(h.store);
    await expect(
      h.service.validatePlan(
        { tenantId: TENANT_A, actorId: '0198f0a0-0000-7000-8000-00000000ffff' },
        planId,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.store.events).toEqual([]);
  });

  it('answers PLAN_NOT_FOUND for an unknown plan, a malformed id and another tenant’s plan alike', async () => {
    const h = harness();
    const planId = seed(h.store);
    await expect(h.service.validatePlan(APPSEC, 'not-a-uuid')).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    await expect(
      h.service.validatePlan(APPSEC, '0198f0a0-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    const otherTenant = { tenantId: TENANT_B, actorId: APPSEC_B };
    await expect(h.service.validatePlan(otherTenant, planId)).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    expect(h.store.events).toEqual([]);
  });

  it('fails closed with PLAN_SA_MISSING when the run has no standing authorisation', async () => {
    const h = harness();
    const planId = seed(
      h.store,
      validSnapshot({ saId: null, authorisation: undefined, runBudgets: undefined }),
    );
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toEqual(['PLAN_SA_MISSING']);
    expect(result.saId).toBeNull();
  });

  it('marks the whole plan invalid with PLAN_SA_NOT_ACTIVE once the SA has expired, and the policy denies it too', async () => {
    const h = harness({ clock: () => new Date('2026-11-02T00:00:00.000Z') });
    const planId = seed(h.store);
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_SA_NOT_ACTIVE', caseId: null }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_POLICY_DENIED', policyId: 'plan.sa_active' }),
    );
  });

  it('treats a revoked SA as not active', async () => {
    const h = harness();
    const planId = seed(
      h.store,
      validSnapshot({ authorisation: activeAuthorisation({ status: 'revoked' }) }),
    );
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.violations.map((v) => v.code)).toContain('PLAN_SA_NOT_ACTIVE');
  });

  it('refuses a destructive case, and the Cedar policy names its policy id too', async () => {
    const h = harness();
    const planId = seed(h.store, validSnapshot({ cases: [caseRow({ class: 'destructive' })] }));
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_CLASS_DESTRUCTIVE_BLOCKED', caseId: CASE_ID }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_POLICY_DENIED', policyId: 'plan.destructive' }),
    );
  });

  it('refuses a state-changing case the SA does not pre-approve', async () => {
    const h = harness();
    const planId = seed(
      h.store,
      validSnapshot({
        cases: [caseRow({ class: 'state_changing' })],
        authorisation: activeAuthorisation({ maxIntrusiveness: 'state_changing' }),
      }),
    );
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.violations.map((v) => v.code)).toContain('PLAN_STATE_CHANGING_NOT_AUTHORISED');
    expect(result.violations.map((v) => v.code)).toContain('PLAN_POLICY_DENIED');
  });

  it('refuses a target outside the SA scope and names the case', async () => {
    const h = harness();
    const planId = seed(
      h.store,
      validSnapshot({ cases: [caseRow({ targets: ['https://elsewhere.test/a'] })] }),
    );
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_TARGET_OUT_OF_SCOPE', caseId: CASE_ID }),
    );
  });

  it('refuses an aggregate over the run request budget with PLAN_BUDGET_EXCEEDED on no case', async () => {
    const h = harness();
    const planId = seed(
      h.store,
      validSnapshot({
        runBudgets: { maxRequests: 40 },
      }),
    );
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: 'PLAN_BUDGET_EXCEEDED', caseId: null }),
    );
    expect(result.budgetTotals.totalRequests).toBe(50);
  });

  it('fails closed with PLAN_POLICY_EVAL_FAILED when the policy engine throws', async () => {
    const broken: PlanPolicyEngine = {
      evaluate: () => {
        throw new Error('engine down');
      },
    };
    const h = harness({ policy: broken });
    const planId = seed(h.store);
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'PLAN_POLICY_EVAL_FAILED', caseId: null }),
    ]);
  });

  it('denies a plain policy denial with no determining policy id', async () => {
    const denying: PlanPolicyEngine = { evaluate: () => ({ decision: 'deny', policyIds: [] }) };
    const h = harness({ policy: denying });
    const planId = seed(h.store);
    const result = await h.service.validatePlan(APPSEC, planId);
    expect(result.violations).toEqual([
      expect.objectContaining({ code: 'PLAN_POLICY_DENIED', policyId: null }),
    ]);
  });

  it('returns no verdict when the audit write fails (the verdict is not written without its record)', async () => {
    const h = harness();
    const planId = seed(h.store);
    h.store.failAudit = true;
    await expect(h.service.validatePlan(APPSEC, planId)).rejects.toThrow('audit unavailable');
    expect(h.outcomes).toEqual(['error']);
  });

  it('counts the outcome and every violation code on the registry', async () => {
    const registry = new Registry();
    const metrics = createPlanValidationMetrics(registry);
    const store = memoryPlanValidationStore();
    const service = new PlanValidationService({
      store,
      memberships: MEMBERSHIPS,
      policy: createCedarPlanPolicy(),
      metrics,
      logger: { info: () => undefined },
      clock: () => NOW,
    });
    const planId = seed(store, validSnapshot({ cases: [caseRow({ class: 'destructive' })] }));
    await service.validatePlan(APPSEC, planId);
    const text = await registry.metrics();
    expect(text).toContain('plan_validation_total{result="invalid"} 1');
    expect(text).toContain('plan_validation_violations{code="PLAN_CLASS_DESTRUCTIVE_BLOCKED"} 1');
  });
});
