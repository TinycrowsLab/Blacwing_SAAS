import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

import type { FindingStatus } from '@blackwing/contracts';

/**
 * The Cedar resource check of the finding read API (FINDING query, CONTEXT_PACK §9). RBAC (`finding:read`) decides
 * the role; Cedar adds the resource rules: tenant isolation, and the Suspected rule of F17. A Suspected finding is
 * readable by an analyst (`appsec_engineer`, the holder of `finding:triage`) only. Deny by default.
 */
export const FINDING_POLICY_SET = `
@id("finding.read")
permit (principal, action == Action::"Finding::read", resource is Finding)
when {
  principal.tenantId == resource.tenantId &&
  !principal.roles.isEmpty() &&
  resource.status != "suspected"
};

@id("finding.read_suspected")
permit (principal, action == Action::"Finding::read", resource is Finding)
when {
  principal.tenantId == resource.tenantId &&
  resource.status == "suspected" &&
  principal.roles.contains("appsec_engineer")
};

@id("finding.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Who asks, as the policy sees them. */
interface FindingPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** What is read: one finding, with the tenant it belongs to and its status. */
export interface FindingPolicyResource {
  /** The `fnd_…` public id, or `*` for a collection-level probe. */
  readonly id: string;
  readonly tenantId: string;
  readonly status: FindingStatus;
}

/** The Cedar port. Implementations must deny on any evaluation problem. */
export interface FindingPolicyEngine {
  allows(principal: FindingPolicyPrincipal, resource: FindingPolicyResource): boolean;
}

/** Thrown at construction when the policy set does not parse: the API refuses to start (fail closed). */
export class FindingPolicyLoadError extends Error {
  constructor(details: string) {
    super(`finding policy set failed to parse: ${details}`);
    this.name = 'FindingPolicyLoadError';
  }
}

/** The Cedar (`@cedar-policy/cedar-wasm`) engine: deterministic (§8.11), and any error is a deny. */
export function createCedarFindingPolicy(
  policyText: string = FINDING_POLICY_SET,
): FindingPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new FindingPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new FindingPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new FindingPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    allows(principal, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Finding', id: resource.id };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: 'Finding::read' },
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
            {
              uid: resourceUid,
              attrs: { tenantId: resource.tenantId, status: resource.status },
              parents: [],
            },
          ],
        });
        if (answer.type !== 'success') return false;
        // An erroring policy is skipped by Cedar; for an authorisation decision we refuse to guess.
        if (answer.response.diagnostics.errors.length > 0) return false;
        return answer.response.decision === 'allow';
      } catch {
        return false;
      }
    },
  };
}
