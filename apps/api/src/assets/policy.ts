import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The Cedar resource check for the asset API (ASSET-002, §9 "RBAC permission + Cedar resource check").
 * RBAC decides first, from the role matrix (`ROLE_PERMISSIONS`); Cedar then checks the resource: same
 * tenant always, and a mutation of an asset is limited to its owner unless the caller is an
 * `appsec_engineer` or `org_admin`. Deny by default; any evaluation problem is a deny.
 */

export const ASSET_ACTIONS = {
  list: 'Asset::list',
  read: 'Asset::read',
  create: 'Asset::create',
  update: 'Asset::update',
  delete: 'Asset::delete',
} as const;
export type AssetAction = (typeof ASSET_ACTIONS)[keyof typeof ASSET_ACTIONS];

/** The baseline asset policy set. Shape-compatible with the shared Cedar schema once #345 lands. */
const ASSET_POLICY_SET = `
@id("asset.read")
permit (principal, action == Action::"${ASSET_ACTIONS.read}", resource is Asset)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("asset:read") };

@id("asset.list")
permit (principal, action == Action::"${ASSET_ACTIONS.list}", resource is Tenant)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("asset:read") };

@id("asset.create")
permit (principal, action == Action::"${ASSET_ACTIONS.create}", resource is Tenant)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("asset:write") };

@id("asset.write")
permit (principal, action in [Action::"${ASSET_ACTIONS.update}", Action::"${ASSET_ACTIONS.delete}"], resource is Asset)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("asset:write") };

@id("asset.owner_scope")
forbid (principal, action in [Action::"${ASSET_ACTIONS.update}", Action::"${ASSET_ACTIONS.delete}"], resource is Asset)
unless {
  principal.roles.contains("appsec_engineer") ||
  principal.roles.contains("org_admin") ||
  resource.ownerUserId == principal.userId
};

@id("asset.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Who asks, as the policy sees them. `permissions` is the RBAC grant the caller's roles resolve to. */
export interface AssetPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

/** What is acted on. A `Tenant` resource is used for `create`, before the asset exists. */
export type AssetPolicyResource =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | {
      readonly kind: 'asset';
      readonly id: string;
      readonly tenantId: string;
      readonly ownerUserId: string;
    };

interface AssetPolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

export interface AssetPolicyEngine {
  authorize(
    principal: AssetPolicyPrincipal,
    action: AssetAction,
    resource: AssetPolicyResource,
  ): AssetPolicyDecision;
}

/** Thrown when the policy set does not parse: the module refuses to start (fail closed). */
class AssetPolicyLoadError extends Error {
  constructor(details: string) {
    super(`asset policy set failed to parse: ${details}`);
    this.name = 'AssetPolicyLoadError';
  }
}

const deny = (errors: readonly string[]): AssetPolicyDecision => ({
  decision: 'deny',
  reasons: [],
  errors,
});

/** Creates the Cedar engine over `policyText`. Deterministic: the same inputs always decide the same. */
export function createCedarAssetPolicy(policyText: string = ASSET_POLICY_SET): AssetPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new AssetPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new AssetPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new AssetPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(principal, action, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid =
        resource.kind === 'asset'
          ? { type: 'Asset', id: resource.id }
          : { type: 'Tenant', id: resource.tenantId };
      const resourceAttrs: Record<string, cedar.CedarValueJson> =
        resource.kind === 'asset'
          ? { tenantId: resource.tenantId, ownerUserId: resource.ownerUserId }
          : { tenantId: resource.tenantId };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: action },
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
                permissions: [...principal.permissions],
              },
              parents: [],
            },
            { uid: resourceUid, attrs: resourceAttrs, parents: [] },
          ],
        });
        if (answer.type !== 'success') return deny(answer.errors.map((e) => e.message));
        const { decision, diagnostics } = answer.response;
        const errors = diagnostics.errors.map((e) => e.error.message);
        if (errors.length > 0) return deny(errors);
        return { decision, reasons: [...diagnostics.reason], errors: [] };
      } catch (err) {
        return deny([err instanceof Error ? err.message : 'cedar evaluation failed']);
      }
    },
  };
}
