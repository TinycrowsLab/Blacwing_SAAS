import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The Cedar resource check of the standing-authorisation API (AUTHZ-002, §9). RBAC (`sa:read`, `sa:create`)
 * decides the role; Cedar adds the resource rules: tenant isolation everywhere, and only the requester
 * changes or submits their own draft (separation of duties, §8.4). Deny by default.
 */
export const SA_POLICY_SET = `
@id("sa.create")
permit (principal, action == Action::"StandingAuthorisation::create", resource is Tenant)
when {
  principal.tenantId == resource.tenantId &&
  (principal.roles.contains("appsec_engineer") || principal.roles.contains("asset_owner"))
};

@id("sa.read")
permit (principal, action == Action::"StandingAuthorisation::read", resource)
when { principal.tenantId == resource.tenantId };

@id("sa.edit_own_draft")
permit (principal, action in [Action::"StandingAuthorisation::update", Action::"StandingAuthorisation::submit"], resource is StandingAuthorisation)
when { principal.tenantId == resource.tenantId && principal.userId == resource.requesterId };

@id("sa.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** The actions the standing-authorisation routes are authorised against. */
export type SaPolicyAction = 'create' | 'read' | 'update' | 'submit';

/** Who asks, as the policy sees them. */
interface SaPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** What is acted on: the tenant itself (create, list) or one standing authorisation. */
export type SaPolicyResource =
  | { readonly kind: 'Tenant'; readonly tenantId: string }
  | {
      readonly kind: 'StandingAuthorisation';
      readonly id: string;
      readonly tenantId: string;
      readonly requesterId: string;
    };

/** The Cedar port. Implementations must deny on any evaluation problem. */
export interface SaPolicyEngine {
  allows(principal: SaPolicyPrincipal, action: SaPolicyAction, resource: SaPolicyResource): boolean;
}

/** Thrown at construction when the policy set does not parse: the API refuses to start (fail closed). */
export class SaPolicyLoadError extends Error {
  constructor(details: string) {
    super(`standing-authorisation policy set failed to parse: ${details}`);
    this.name = 'SaPolicyLoadError';
  }
}

/** The Cedar (`@cedar-policy/cedar-wasm`) engine: deterministic (§8.11), and any error is a deny. */
export function createCedarSaPolicy(policyText: string = SA_POLICY_SET): SaPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new SaPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  // Key each policy by its `@id` annotation so the set is checked by name.
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id)) throw new SaPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new SaPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    allows(principal, action, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid =
        resource.kind === 'Tenant'
          ? { type: 'Tenant', id: resource.tenantId }
          : { type: 'StandingAuthorisation', id: resource.id };
      const resourceAttrs: Record<string, cedar.CedarValueJson> =
        resource.kind === 'Tenant'
          ? { tenantId: resource.tenantId }
          : { tenantId: resource.tenantId, requesterId: resource.requesterId };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: `StandingAuthorisation::${action}` },
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
