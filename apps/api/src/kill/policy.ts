import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

import type { KillApiScope } from '@blackwing/contracts';

/** The Cedar action every tenant kill is authorised against (KILL-003 requirement 4). */
export const KILL_TRIGGER_ACTION = 'Kill::trigger';

/**
 * The baseline `Kill::trigger` policy set (§8.4, §8.6). Deny by default: only these permits allow.
 *
 * - `appsec_engineer` and `org_admin` may kill a run or an asset of their own tenant.
 * - `asset_owner` may kill only an asset they own (the SoD-adjacent ownership rule, §1.2).
 * - only `org_admin` may kill the whole tenant.
 * - a tenant mismatch is always forbidden, whatever a permit says.
 *
 * The shared Cedar schema and the customer-owned layer arrive with the policy package (#345, #585);
 * this set is shape-compatible with their `User`/`Asset`/`Run` entities.
 */
export const KILL_POLICY_SET = `
@id("kill.run")
permit (principal, action == Action::"${KILL_TRIGGER_ACTION}", resource is Run)
when {
  principal.tenantId == resource.tenantId &&
  (principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin"))
};

@id("kill.asset")
permit (principal, action == Action::"${KILL_TRIGGER_ACTION}", resource is Asset)
when {
  principal.tenantId == resource.tenantId &&
  (principal.roles.contains("appsec_engineer") ||
   principal.roles.contains("org_admin") ||
   (principal.roles.contains("asset_owner") && resource.ownerUserIds.contains(principal.userId)))
};

@id("kill.tenant")
permit (principal, action == Action::"${KILL_TRIGGER_ACTION}", resource is Tenant)
when { principal.tenantId == resource.tenantId && principal.roles.contains("org_admin") };

@id("kill.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Who asks, as the policy sees them. */
export interface KillPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** What would be killed, as the policy sees it. `ownerUserIds` is set for an asset only. */
export interface KillPolicyResource {
  readonly scope: KillApiScope;
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserIds?: readonly string[];
}

/** The decision, plus the policy ids that produced it (for the audit event) or the evaluation errors. */
export interface KillPolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

/** The Cedar resource check port. Implementations must deny on any evaluation problem. */
export interface KillPolicyEngine {
  authorize(principal: KillPolicyPrincipal, resource: KillPolicyResource): KillPolicyDecision;
}

const ENTITY_TYPE: Readonly<Record<KillApiScope, string>> = Object.freeze({
  run: 'Run',
  asset: 'Asset',
  tenant: 'Tenant',
});

/** Thrown at construction when the policy set does not parse: the API refuses to start (fail closed). */
export class KillPolicyLoadError extends Error {
  constructor(details: string) {
    super(`kill policy set failed to parse: ${details}`);
    this.name = 'KillPolicyLoadError';
  }
}

const deny = (errors: readonly string[]): KillPolicyDecision => ({
  decision: 'deny',
  reasons: [],
  errors,
});

/**
 * The Cedar (`@cedar-policy/cedar-wasm`) engine. Deterministic (§8.11): the same principal and
 * resource always give the same decision. Any failure to evaluate is a deny.
 */
export function createCedarKillPolicy(policyText: string = KILL_POLICY_SET): KillPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new KillPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  // Key each policy by its `@id` annotation so decisions name the policy that produced them.
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new KillPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new KillPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(principal, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: ENTITY_TYPE[resource.scope], id: resource.id };
      const resourceAttrs: Record<string, cedar.CedarValueJson> = { tenantId: resource.tenantId };
      if (resource.scope === 'asset') {
        resourceAttrs.ownerUserIds = [...(resource.ownerUserIds ?? [])];
      }
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: KILL_TRIGGER_ACTION },
          resource: resourceUid,
          context: {},
          policies: { staticPolicies },
          entities: [
            {
              uid: principalUid,
              attrs: {
                userId: principal.userId,
                tenantId: principal.tenantId,
                roles: [...principal.roles],
              },
              parents: [],
            },
            { uid: resourceUid, attrs: resourceAttrs, parents: [] },
          ],
        });
        if (answer.type !== 'success') return deny(answer.errors.map((e) => e.message));
        const { decision, diagnostics } = answer.response;
        const errors = diagnostics.errors.map((e) => e.error.message);
        // An erroring policy is skipped by Cedar; for a safety action we refuse to guess.
        if (errors.length > 0) return deny(errors);
        return { decision, reasons: [...diagnostics.reason], errors: [] };
      } catch (err) {
        return deny([err instanceof Error ? err.message : 'cedar evaluation failed']);
      }
    },
  };
}
