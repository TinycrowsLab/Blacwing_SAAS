import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The Cedar policy of plan validation (PLAN-006, §8.1, §8.3, §8.6). It is the second opinion on a plan: the
 * deterministic checks in `rules.ts` run first, and this decides who may validate a plan and whether the plan is
 * still permitted under the SA. Deny by default: a `permit` is needed, and every `forbid` wins over it.
 *
 * Entities: `User` (the caller, with tenant and roles) and `Plan` (the version, with the facts the checks computed).
 * Cedar never does scope matching here (that is `rules.ts`); it only sees booleans and counts.
 */

/** The Cedar action a plan validation is authorised against. */
const VALIDATE_ACTION = 'PlanValidation::validate';

export const PLAN_POLICY_SET = `
@id("plan.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };

@id("plan.validate.roles")
permit (principal, action == Action::"${VALIDATE_ACTION}", resource)
when { principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin") };

@id("plan.sa_active")
forbid (principal, action == Action::"${VALIDATE_ACTION}", resource)
when { !resource.saActive };

@id("plan.destructive")
forbid (principal, action == Action::"${VALIDATE_ACTION}", resource)
when { resource.destructiveCases > 0 };

@id("plan.state_changing.authorised")
forbid (principal, action == Action::"${VALIDATE_ACTION}", resource)
when { resource.stateChangingCases > 0 && !resource.stateChangingAuthorised };
`;

/** The facts about a plan version the policy decides on. Counts and booleans only. */
export interface PlanPolicyResource {
  readonly tenantId: string;
  readonly planId: string;
  /** The SA is active at validation time (the checks computed it). */
  readonly saActive: boolean;
  readonly destructiveCases: number;
  readonly stateChangingCases: number;
  /** The SA pre-approves the state-changing class, so state-changing cases may run without a Gate 1 denial here. */
  readonly stateChangingAuthorised: boolean;
}

export interface PlanPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/**
 * `allow`, or `deny` with the ids of the policies that decided it (empty when no permit applied). Callers treat any
 * `deny` as a violation. Evaluation errors throw; the caller turns a throw into a fail-closed violation.
 */
interface PlanPolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly policyIds: readonly string[];
}

/** The plan policy engine. Implementations must be deterministic (§8.11) and never allow on error. */
export interface PlanPolicyEngine {
  evaluate(principal: PlanPolicyPrincipal, resource: PlanPolicyResource): PlanPolicyDecision;
}

/** Thrown at construction when the policy set does not parse: the module refuses to mount (fail closed). */
export class PlanPolicyLoadError extends Error {
  constructor(details: string) {
    super(`plan policy set failed to parse: ${details}`);
    this.name = 'PlanPolicyLoadError';
  }
}

/** Thrown when the engine cannot evaluate a request (a policy error or a malformed answer). */
class PlanPolicyEvaluationError extends Error {
  constructor(details: string) {
    super(`plan policy evaluation failed: ${details}`);
    this.name = 'PlanPolicyEvaluationError';
  }
}

/** The policy id of each text in the set, read from its `@id` annotation. Duplicate ids are refused. */
function staticPoliciesOf(policyText: string): Record<string, string> {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new PlanPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new PlanPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  return staticPolicies;
}

/**
 * The Cedar (`@cedar-policy/cedar-wasm`) plan engine. Parses the policy set once, at construction; every evaluation
 * then runs against that parsed set and fails closed on any error.
 */
export function createCedarPlanPolicy(policyText: string = PLAN_POLICY_SET): PlanPolicyEngine {
  const staticPolicies = staticPoliciesOf(policyText);
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new PlanPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    evaluate(principal, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Plan', id: resource.planId };
      const answer = cedar.isAuthorized({
        principal: principalUid,
        action: { type: 'Action', id: VALIDATE_ACTION },
        resource: resourceUid,
        context: {},
        policies: { staticPolicies },
        entities: [
          {
            uid: principalUid,
            attrs: { tenantId: principal.tenantId, roles: [...principal.roles] },
            parents: [],
          },
          {
            uid: resourceUid,
            attrs: {
              tenantId: resource.tenantId,
              saActive: resource.saActive,
              destructiveCases: resource.destructiveCases,
              stateChangingCases: resource.stateChangingCases,
              stateChangingAuthorised: resource.stateChangingAuthorised,
            },
            parents: [],
          },
        ],
      });
      if (answer.type !== 'success') {
        throw new PlanPolicyEvaluationError(answer.errors.map((e) => e.message).join('; '));
      }
      const { decision, diagnostics } = answer.response;
      if (diagnostics.errors.length > 0) {
        throw new PlanPolicyEvaluationError(diagnostics.errors.map((e) => e.policyId).join('; '));
      }
      return {
        decision: decision === 'allow' ? 'allow' : 'deny',
        policyIds: [...diagnostics.reason],
      };
    },
  };
}
