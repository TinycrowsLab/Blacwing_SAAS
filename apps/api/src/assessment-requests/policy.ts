import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/** The Cedar action every assessment-request resource check is authorised against (SCOPE-005 requirement 6). */
const ASSESSMENT_ACTION = 'AssessmentRequest::act';

/**
 * Asset-level policy of the assessment-request API (§8.6, RBAC-004). RBAC decides what a role may do; this decides
 * on which assets. Deny by default:
 *
 * - an `appsec_engineer` or an `org_admin` (the two roles RBAC grants `assessment:create`) may act on any asset of
 *   their tenant;
 * - an `asset_owner` may act only on an asset they own;
 * - a tenant mismatch is always forbidden, whatever a permit says.
 */
export const ASSESSMENT_POLICY_SET = `
@id("assessment.appsec")
permit (principal, action == Action::"${ASSESSMENT_ACTION}", resource is Asset)
when {
  principal.tenantId == resource.tenantId &&
  (principal.roles.contains("appsec_engineer") || principal.roles.contains("org_admin"))
};

@id("assessment.owner")
permit (principal, action == Action::"${ASSESSMENT_ACTION}", resource is Asset)
when {
  principal.tenantId == resource.tenantId &&
  principal.roles.contains("asset_owner") &&
  resource.ownerUserIds.contains(principal.userId)
};

@id("assessment.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

export interface AssessmentPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

interface AssessmentPolicyAsset {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserIds: readonly string[];
}

/** The asset-level decision. Anything but `allow` is a refusal. */
export interface AssessmentPolicyEngine {
  authorize(principal: AssessmentPolicyPrincipal, asset: AssessmentPolicyAsset): 'allow' | 'deny';
}

/** Thrown at construction when the policy set does not parse: the module refuses to mount (fail closed). */
export class AssessmentPolicyLoadError extends Error {
  constructor(details: string) {
    super(`assessment policy set failed to parse: ${details}`);
    this.name = 'AssessmentPolicyLoadError';
  }
}

/**
 * The Cedar (`@cedar-policy/cedar-wasm`) engine. Deterministic (§8.11). Any evaluation error is a deny: the
 * policy is never guessed around.
 */
export function createCedarAssessmentPolicy(
  policyText: string = ASSESSMENT_POLICY_SET,
): AssessmentPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new AssessmentPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new AssessmentPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new AssessmentPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(principal, asset) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Asset', id: asset.id };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: ASSESSMENT_ACTION },
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
              attrs: { tenantId: asset.tenantId, ownerUserIds: [...asset.ownerUserIds] },
              parents: [],
            },
          ],
        });
        if (answer.type !== 'success') return 'deny';
        const { decision, diagnostics } = answer.response;
        if (diagnostics.errors.length > 0) return 'deny';
        return decision === 'allow' ? 'allow' : 'deny';
      } catch {
        return 'deny';
      }
    },
  };
}
