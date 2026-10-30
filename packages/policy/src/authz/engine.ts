import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isAuthorized, policySetTextToParts } from '@cedar-policy/cedar-wasm/nodejs';

import { validatePolicies, validateSchema } from '../schema.js';
import {
  toCedarRequest,
  type AuthzAction,
  type AuthzPrincipal,
  type AuthzResource,
} from './entities.js';

/** The resource-level schema and baseline policy text (`schema/authz.cedarschema`, `policies/authz`). */
export interface AuthzSources {
  readonly schema: string;
  readonly policies: string;
}

/** The decision for one request. `allow` is true only for a Cedar `Allow` with no evaluation error. */
export interface AuthzDecision {
  readonly allow: boolean;
  /** Ids of the policies that determined the decision (`authz.*`). */
  readonly reasons: readonly string[];
  /** Cedar evaluation or validation errors; any entry forces a deny. */
  readonly errors: readonly string[];
}

export interface AuthzEngine {
  can(principal: AuthzPrincipal, action: AuthzAction, resource: AuthzResource): AuthzDecision;
}

/** Thrown when the authz schema or baseline does not validate. The service must refuse to start. */
export class AuthzPolicyLoadError extends Error {
  override readonly name = 'AuthzPolicyLoadError';
}

const schemaPath = fileURLToPath(new URL('../../schema/authz.cedarschema', import.meta.url));
const policyPath = fileURLToPath(new URL('../../policies/authz/resource.cedar', import.meta.url));

/** Reads the shipped schema and baseline from the package. */
export function loadAuthzSources(): AuthzSources {
  return {
    schema: readFileSync(schemaPath, 'utf8'),
    policies: readFileSync(policyPath, 'utf8'),
  };
}

/**
 * Splits a policy set into policy id to text, keyed by each policy's `@id`, so the reasons a
 * decision reports are the readable `authz.*` ids. An entry without exactly one unique `@id` is
 * left to fail validation under its own generated key.
 */
function splitByPolicyId(policySet: string): Record<string, string> {
  const parts = policySetTextToParts(policySet);
  if (parts.type !== 'success') {
    throw new AuthzPolicyLoadError(
      `authz policies are invalid: ${parts.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const staticPolicies: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\("([^"]+)"\)/.exec(text)?.[1] ?? `unnamed.${String(index)}`;
    if (Object.hasOwn(staticPolicies, id)) {
      throw new AuthzPolicyLoadError(`duplicate authz policy id ${id}`);
    }
    staticPolicies[id] = text;
  });
  return staticPolicies;
}

const deny = (errors: readonly string[]): AuthzDecision => ({
  allow: false,
  reasons: [],
  errors,
});

/**
 * Validates the schema and the policies strictly (unknown attributes, type errors and validator
 * warnings all reject) and returns an engine. Validation happens once, here, so a broken baseline
 * can never answer a request.
 */
export function createAuthzEngine(sources: AuthzSources = loadAuthzSources()): AuthzEngine {
  const schemaCheck = validateSchema(sources.schema);
  if (!schemaCheck.ok) {
    throw new AuthzPolicyLoadError(`authz schema is invalid: ${schemaCheck.errors.join('; ')}`);
  }
  const staticPolicies = splitByPolicyId(sources.policies);
  const policyCheck = validatePolicies(staticPolicies, sources.schema);
  if (!policyCheck.ok) {
    throw new AuthzPolicyLoadError(`authz policies are invalid: ${policyCheck.errors.join('; ')}`);
  }
  const policies = { staticPolicies };

  return {
    can(principal, action, resource) {
      try {
        const request = toCedarRequest(principal, action, resource);
        const answer = isAuthorized({
          principal: request.principal,
          action: request.action,
          resource: request.resource,
          context: {},
          policies,
          entities: [...request.entities],
        });
        if (answer.type !== 'success') return deny(answer.errors.map((e) => e.message));
        const { decision, diagnostics } = answer.response;
        const errors = diagnostics.errors.map((e) => e.error.message);
        if (errors.length > 0) return deny(errors);
        return {
          allow: decision === 'allow',
          reasons: [...diagnostics.reason],
          errors: [],
        };
      } catch (err) {
        return deny([err instanceof Error ? err.message : 'cedar evaluation failed']);
      }
    },
  };
}

let defaultEngine: AuthzEngine | undefined;

/**
 * The process-wide engine over the shipped baseline, created on first use. Creation throws
 * `AuthzPolicyLoadError` if the baseline is broken, so no caller can fall back to allow.
 */
export function authzEngine(): AuthzEngine {
  defaultEngine ??= createAuthzEngine();
  return defaultEngine;
}

/** Decides one resource action with the shipped baseline. Deny unless Cedar allows. */
export function can(
  principal: AuthzPrincipal,
  action: AuthzAction,
  resource: AuthzResource,
): AuthzDecision {
  return authzEngine().can(principal, action, resource);
}
