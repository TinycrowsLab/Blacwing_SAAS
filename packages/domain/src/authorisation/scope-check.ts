import {
  type IntrusivenessClass,
  isWithinCeiling,
  parseScopeRules,
  type ScopeTarget,
} from '@blackwing/contracts';

import { matchScope } from '../scope/matcher.js';

/**
 * Scope and intrusiveness checks for a standing authorisation (AUTHZ-005, §8.2, §8.3). They sit here, not in
 * `@blackwing/crypto`, because they reuse the SCOPE matcher, and the dependency graph keeps crypto a leaf. Both are
 * pure and fail closed: any rules or class they cannot read deny the request.
 */

/** The scope rules an SA carries, as stored (JSON column). */
export interface ScopedAuthorisation {
  readonly scopeRules: unknown;
}

/** The intrusiveness ceiling an SA carries. */
export interface IntrusivenessBoundedAuthorisation {
  readonly maxIntrusiveness: IntrusivenessClass;
}

/** True when the SCOPE matcher places `target` in scope under the SA's rules. Unreadable rules are out of scope. */
export function scopeAllows(sa: ScopedAuthorisation, target: ScopeTarget): boolean {
  let rules;
  try {
    rules = parseScopeRules(sa.scopeRules);
  } catch {
    return false;
  }
  return matchScope(target, rules).inScope;
}

/** True when a step of intrusiveness `requested` is within the SA's ceiling. `destructive` is never within it (§8.3). */
export function intrusivenessAllowed(
  sa: IntrusivenessBoundedAuthorisation,
  requested: IntrusivenessClass,
): boolean {
  return isWithinCeiling(requested, sa.maxIntrusiveness);
}
