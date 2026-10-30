import { ForbiddenError } from '@blackwing/errors';
import { createLogger, type Logger } from '@blackwing/logger';

import { can } from './engine.js';

import type { AuthzAction, AuthzPrincipal, AuthzResource } from './entities.js';

/** The part of the logger a decision needs. Tests pass a recorder; production uses the default. */
export type AuthzDecisionLog = Pick<Logger, 'debug' | 'warn'>;

const defaultLog = createLogger('@blackwing/policy');

/**
 * The resource check the controllers and guards call after the RBAC permission guard (§9, #345).
 * Returns when Cedar allows. Otherwise throws `ForbiddenError` (403, FORBIDDEN) with no detail,
 * so a cross-tenant lookup looks the same as an ownership denial. Every decision is logged as
 * `cedar.decision` with the action, resource type, outcome and deciding policy ids. No ids of
 * users or tenants are logged.
 */
export function checkResource(
  principal: AuthzPrincipal,
  action: AuthzAction,
  resource: AuthzResource,
  log: AuthzDecisionLog = defaultLog,
): void {
  const decision = can(principal, action, resource);
  const fields = {
    action,
    resourceType: resource.kind,
    decision: decision.allow ? 'allow' : 'deny',
    reason:
      decision.errors.length > 0
        ? 'evaluation_error'
        : decision.reasons.join(',') || 'no_matching_permit',
    errorCount: decision.errors.length,
  };
  if (decision.allow) {
    log.debug(fields, 'cedar.decision');
    return;
  }
  log.warn(fields, 'cedar.decision');
  throw new ForbiddenError('Forbidden');
}
