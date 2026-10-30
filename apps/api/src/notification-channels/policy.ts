import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/**
 * The Cedar resource check for the notification channel API (NOTIFY-001, §9 "RBAC permission + Cedar resource
 * check"). RBAC decides first: the caller's roles must grant `notifications:manage`. Cedar then checks the
 * resource: the principal and the tenant are the same tenant, and the grant is present on the principal.
 * Deny by default; any evaluation problem is a deny.
 */

export const CHANNEL_ACTIONS = {
  manage: 'NotificationChannel::manage',
} as const;

const CHANNEL_POLICY_SET = `
@id("notification_channel.manage")
permit (principal, action == Action::"${CHANNEL_ACTIONS.manage}", resource is Tenant)
when { principal.tenantId == resource.tenantId && principal.permissions.contains("notifications:manage") };

@id("notification_channel.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Who asks, as the policy sees them. `permissions` is the RBAC grant the caller's roles resolve to. */
export interface ChannelPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface ChannelPolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

export interface ChannelPolicyEngine {
  authorize(principal: ChannelPolicyPrincipal, tenantId: string): ChannelPolicyDecision;
}

/** Thrown when the policy set does not parse: the module refuses to start (fail closed). */
class ChannelPolicyLoadError extends Error {
  constructor(details: string) {
    super(`notification channel policy set failed to parse: ${details}`);
    this.name = 'ChannelPolicyLoadError';
  }
}

const deny = (errors: readonly string[]): ChannelPolicyDecision => ({
  decision: 'deny',
  reasons: [],
  errors,
});

/** Creates the Cedar engine over `policyText`. Deterministic: the same inputs always decide the same. */
export function createCedarChannelPolicy(
  policyText: string = CHANNEL_POLICY_SET,
): ChannelPolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new ChannelPolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new ChannelPolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new ChannelPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(principal, tenantId) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Tenant', id: tenantId };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: CHANNEL_ACTIONS.manage },
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
            { uid: resourceUid, attrs: { tenantId }, parents: [] },
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
