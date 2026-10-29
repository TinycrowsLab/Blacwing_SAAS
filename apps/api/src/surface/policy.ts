import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/** The Cedar action a surface read is authorised against (GRAPH-006 requirement 4). */
export const SURFACE_READ_ACTION = 'Surface::read';

/**
 * The surface-read policy set (§8.6, §9). Deny by default: only the permit below allows.
 *
 * - a caller reads the surface of a run of their own tenant (`principal.tenantId == resource.tenantId`);
 * - an `asset_owner` reads it only when they own the run's asset (the ownership rule of §1.2); every other tenant
 *   role reads any run of the tenant.
 * - a tenant mismatch is always forbidden, whatever a permit says.
 */
export const SURFACE_POLICY_SET = `
@id("surface.read")
permit (principal, action == Action::"${SURFACE_READ_ACTION}", resource is Run)
when {
  principal.tenantId == resource.tenantId &&
  (!principal.roles.contains("asset_owner") || resource.ownerUserIds.contains(principal.userId))
};

@id("surface.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Who reads, as the policy sees them. */
interface SurfacePolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

/** The run read, as the policy sees it. */
interface SurfacePolicyRun {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserIds: readonly string[];
}

/** The Cedar resource check. Implementations must deny on any evaluation problem. */
export interface SurfacePolicyEngine {
  allows(principal: SurfacePolicyPrincipal, run: SurfacePolicyRun): boolean;
}

/** Thrown at construction when the policy set does not parse: the API refuses to start (fail closed). */
export class SurfacePolicyLoadError extends Error {
  constructor(details: string) {
    super(`surface policy set failed to parse: ${details}`);
    this.name = 'SurfacePolicyLoadError';
  }
}

/** The Cedar (`@cedar-policy/cedar-wasm`) engine. Deterministic (§8.11); any evaluation error is a deny. */
export function createCedarSurfacePolicy(
  policyText: string = SURFACE_POLICY_SET,
): SurfacePolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new SurfacePolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new SurfacePolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new SurfacePolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    allows(principal, run) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Run', id: run.id };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: SURFACE_READ_ACTION },
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
              attrs: { tenantId: run.tenantId, ownerUserIds: [...run.ownerUserIds] },
              parents: [],
            },
          ],
        });
        if (answer.type !== 'success') return false;
        // An erroring policy is skipped by Cedar; for a read of security-relevant data we refuse to guess.
        if (answer.response.diagnostics.errors.length > 0) return false;
        return answer.response.decision === 'allow';
      } catch {
        return false;
      }
    },
  };
}
