import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The Cedar resource check for tenant policy sets (POLICY-001, §9 "RBAC permission + Cedar resource check").
 * RBAC decides first (`policy:read` / `policy:write` in the role matrix); Cedar then checks the resource: the
 * caller's tenant must be the policy set's tenant, always. Deny by default; any evaluation problem is a deny.
 * The platform baseline is not a resource here: it is shipped in `@blackwing/policy` and has no edit path.
 */

export type PolicyAction = 'read' | 'edit';

/** One Cedar policy per id (Cedar's static-policy map): the reads, the edits and the tenant isolation floor. */
const POLICY_SET: Readonly<Record<string, string>> = {
  'policy.read': `@id("policy.read")
permit (principal, action == Action::"read", resource is TenantPolicySet)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("policy:read") };`,
  'policy.edit': `@id("policy.edit")
permit (principal, action == Action::"edit", resource is TenantPolicySet)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("policy:write") };`,
  'policy.tenant_isolation': `@id("policy.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };`,
};

/** Who asks: the tenant they act in and the RBAC permissions their roles grant. */
interface PolicyPrincipal {
  readonly id: string;
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

interface PolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly errors: readonly string[];
}

export interface TenantPolicyEngine {
  authorize(principal: PolicyPrincipal, action: PolicyAction, tenantId: string): PolicyDecision;
}

const deny = (errors: readonly string[]): PolicyDecision => ({ decision: 'deny', errors });

/** Builds the engine. Deterministic: the same inputs always decide the same way. */
export function createTenantPolicyEngine(
  policies: Readonly<Record<string, string>> = POLICY_SET,
): TenantPolicyEngine {
  const parsed = cedar.checkParsePolicySet({ staticPolicies: { ...policies } });
  if (parsed.type !== 'success') {
    throw new Error(
      `tenant policy engine failed to load: ${parsed.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return {
    authorize(principal, action, tenantId) {
      const principalUid = { type: 'User', id: principal.id };
      const resourceUid = { type: 'TenantPolicySet', id: tenantId };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: action },
          resource: resourceUid,
          context: {},
          policies: { staticPolicies: { ...policies } },
          entities: [
            {
              uid: principalUid,
              attrs: { tenantId: principal.tenantId, permissions: [...principal.permissions] },
              parents: [],
            },
            { uid: resourceUid, attrs: { tenantId }, parents: [] },
          ],
        });
        if (answer.type !== 'success') return deny(answer.errors.map((e) => e.message));
        const { decision, diagnostics } = answer.response;
        const errors = diagnostics.errors.map((e) => e.error.message);
        if (errors.length > 0) return deny(errors);
        return { decision: decision === 'allow' ? 'allow' : 'deny', errors: [] };
      } catch (error) {
        return deny([error instanceof Error ? error.message : 'cedar evaluation failed']);
      }
    },
  };
}
