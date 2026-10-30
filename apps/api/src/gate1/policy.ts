import * as cedar from '@cedar-policy/cedar-wasm/nodejs';

import { sodCedarCondition } from '@blackwing/domain/sod';

import type { Gate1PolicyEngine, Gate1PolicyInput } from './ports.js';

/** The Cedar action every Gate 1 decision is authorised against. */
const GATE1_ACTION = 'Run::decideGate1';

/**
 * Gate 1 decision policy (#398, CONTEXT_PACK §8.4, §8.6). Deny by default. The Cedar layer is the second, independent
 * copy of the separation-of-duties rule: service code checks it first, and the database check on
 * `authz_gate_decisions` checks it a third time.
 *
 * - a caller who holds `testplan:approve` (`canApprove`) in the run's tenant may decide;
 * - the requester may never decide (`forbid` on `resource.requesterId == principal.id`, the shared
 *   {@link sodCedarCondition});
 * - a run with no known requester is refused (fail closed: nobody is known to be separated from the plan);
 * - a tenant mismatch is always refused, whatever a permit says.
 */
const GATE1_POLICY_SET = `
@id("gate1.approver")
permit (principal, action == Action::"${GATE1_ACTION}", resource)
when {
  principal.tenantId == resource.tenantId &&
  principal.canApprove == true
};

@id("gate1.separation_of_duties")
forbid (principal, action, resource)
when { ${sodCedarCondition()} };

@id("gate1.requester_known")
forbid (principal, action, resource)
unless { resource has requesterId };

@id("gate1.tenant_isolation")
forbid (principal, action, resource)
unless { principal has tenantId && resource has tenantId && principal.tenantId == resource.tenantId };
`;

/** Thrown at construction when the Gate 1 policy does not parse: the service refuses to start (fail closed). */
export class Gate1PolicyLoadError extends Error {
  constructor(details: string) {
    super(`gate1 policy set failed to parse: ${details}`);
    this.name = 'Gate1PolicyLoadError';
  }
}

/** The Cedar (`@cedar-policy/cedar-wasm`) engine for Gate 1. Any evaluation error is a deny. */
export function createCedarGate1Policy(policyText: string = GATE1_POLICY_SET): Gate1PolicyEngine {
  const parts = cedar.policySetTextToParts(policyText);
  if (parts.type !== 'success') {
    throw new Gate1PolicyLoadError(parts.errors.map((e) => e.message).join('; '));
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `policy${String(index)}`;
    if (Object.hasOwn(staticPolicies, id))
      throw new Gate1PolicyLoadError(`duplicate policy id ${id}`);
    staticPolicies[id] = text;
  });
  const parsed = cedar.checkParsePolicySet({ staticPolicies });
  if (parsed.type !== 'success') {
    throw new Gate1PolicyLoadError(parsed.errors.map((e) => e.message).join('; '));
  }
  return {
    authorize(input: Gate1PolicyInput) {
      return evaluate(staticPolicies, input);
    },
  };
}

function evaluate(
  staticPolicies: Record<string, string>,
  input: Gate1PolicyInput,
): 'allow' | 'deny' {
  const principalUid = { type: 'User', id: input.principal.id };
  const resourceUid = { type: 'Run', id: input.resource.runId };
  try {
    const attrs: Record<string, string> = {
      tenantId: input.resource.tenantId,
    };
    if (input.resource.requesterId !== null) attrs.requesterId = input.resource.requesterId;
    const answer = cedar.isAuthorized({
      principal: principalUid,
      action: { type: 'Action', id: GATE1_ACTION },
      resource: resourceUid,
      context: {},
      policies: { staticPolicies },
      entities: [
        {
          uid: principalUid,
          attrs: {
            id: input.principal.id,
            tenantId: input.principal.tenantId,
            canApprove: input.principal.canApprove,
          },
          parents: [],
        },
        { uid: resourceUid, attrs, parents: [] },
      ],
    });
    if (answer.type !== 'success') return 'deny';
    if (answer.response.diagnostics.errors.length > 0) return 'deny';
    return answer.response.decision === 'allow' ? 'allow' : 'deny';
  } catch {
    return 'deny';
  }
}
