import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

/** The Cedar actions the secrets API is authorised against (SECRETS-004 requirement 5). */
export const SECRET_WRITE_ACTION = 'Secret::write';
export const SECRET_READ_META_ACTION = 'Secret::read_meta';
export type SecretPolicyAction = typeof SECRET_WRITE_ACTION | typeof SECRET_READ_META_ACTION;

/**
 * The baseline secrets policy set (§8.6). Deny by default. The RBAC permission (`secret:write`,
 * `secret:read`: Org Admin only) is checked first; this is the resource check that scopes every secret
 * to the caller's tenant, and a tenant mismatch is forbidden whatever a permit says. The customer layer
 * and the shared Cedar schema arrive with the policy package (#345, #585).
 */
export const SECRET_POLICY_SET = `
@id("secret.tenant_scope")
permit (principal, action in [Action::"${SECRET_WRITE_ACTION}", Action::"${SECRET_READ_META_ACTION}"], resource is Secret)
when { principal.tenantId == resource.tenantId };

@id("secret.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

export interface SecretPolicyPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
}

export interface SecretPolicyResource {
  readonly id: string;
  readonly tenantId: string;
}

/** The decision, plus the evaluation errors (for the audit event) when Cedar could not decide. */
export interface SecretPolicyDecision {
  readonly decision: 'allow' | 'deny';
  readonly errors: readonly string[];
}

/** The Cedar resource check port. Implementations must deny on any evaluation problem. */
export interface SecretPolicyEngine {
  authorize(
    principal: SecretPolicyPrincipal,
    action: SecretPolicyAction,
    resource: SecretPolicyResource,
  ): SecretPolicyDecision;
}

/** Thrown at construction when the policy set does not parse: the API refuses to start (fail closed). */
export class SecretPolicyLoadError extends Error {
  constructor(details: string) {
    super(`secret policy set failed to parse: ${details}`);
    this.name = 'SecretPolicyLoadError';
  }
}

const deny = (errors: readonly string[]): SecretPolicyDecision => ({ decision: 'deny', errors });

/** The Cedar (`@cedar-policy/cedar-wasm`) engine. Deterministic; any failure to evaluate is a deny. */
export function createCedarSecretPolicy(
  policyText: string = SECRET_POLICY_SET,
): SecretPolicyEngine {
  const parsed = cedar.checkParsePolicySet({ staticPolicies: policyText });
  if (parsed.type !== 'success') {
    throw new SecretPolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(principal, action, resource) {
      const principalUid = { type: 'User', id: principal.userId };
      const resourceUid = { type: 'Secret', id: resource.id };
      try {
        const answer = cedar.isAuthorized({
          principal: principalUid,
          action: { type: 'Action', id: action },
          resource: resourceUid,
          context: {},
          policies: { staticPolicies: policyText },
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
            { uid: resourceUid, attrs: { tenantId: resource.tenantId }, parents: [] },
          ],
        });
        if (answer.type !== 'success') return deny(answer.errors.map((e) => e.message));
        const errors = answer.response.diagnostics.errors.map((e) => e.error.message);
        // An erroring policy is skipped by Cedar; for a secret we refuse to guess.
        if (errors.length > 0) return deny(errors);
        return { decision: answer.response.decision, errors: [] };
      } catch (err) {
        return deny([err instanceof Error ? err.message : 'cedar evaluation failed']);
      }
    },
  };
}
