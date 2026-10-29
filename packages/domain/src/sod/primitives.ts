import { ValidationError } from '@blackwing/errors';

import { SOD_VIOLATION_LOG_MESSAGE, SodViolationError, type SodViolationReason } from './error.js';

import type { SodOptions } from './sink.js';

/**
 * Separation-of-duties primitives (#352). Pure: no IO. Enforcement is on `user_id` (identity), never on role,
 * so one person wearing two hats still cannot approve their own request. Every missing actor fails closed
 * (`null_actor`), and every refusal is logged at warn before it is thrown.
 */

/** Roles that may approve. Only `asset_owner` holds `sa:approve` / `gate:decide` (RBAC-001 matrix). */
export const APPROVER_ROLES = ['asset_owner'] as const;

/** Roles that mark an unattended principal. Such a principal is never an approver, even alongside an approver role. */
export const SERVICE_ROLES = ['ci_pipeline'] as const;

function refuse(
  reason: SodViolationReason,
  context: string,
  requesterId: string | null | undefined,
  actorId: string | null | undefined,
  options: SodOptions,
): SodViolationError {
  options.logger?.warn(
    {
      context,
      requesterId: requesterId ?? null,
      actorId: actorId ?? null,
      reason,
    },
    SOD_VIOLATION_LOG_MESSAGE,
  );
  return new SodViolationError(reason, context);
}

/** Throws `null_actor` for a missing or empty id (fail closed), and `requester_equals_approver` when they match. */
export function assertDifferentActors(
  requesterId: string | null | undefined,
  actorId: string | null | undefined,
  context: string,
  options: SodOptions = {},
): void {
  if (!requesterId || !actorId) {
    throw refuse('null_actor', context, requesterId, actorId, options);
  }
  if (requesterId === actorId) {
    throw refuse('requester_equals_approver', context, requesterId, actorId, options);
  }
}

/**
 * Throws `insufficient_approvers` unless at least `min` distinct approvers other than the requester remain.
 * Duplicate ids count once. A missing approver id is `null_actor`. When `requesterId` is passed, it must be
 * present (`null_actor` otherwise) and is never counted as an approver.
 */
export function assertMinApprovers(
  approverIds: readonly (string | null | undefined)[],
  min = 1,
  requesterId?: string | null,
  context = 'min_approvers',
  options: SodOptions = {},
): void {
  if (!Number.isInteger(min) || min < 1) {
    throw new ValidationError(`min approvers must be a positive integer, got ${String(min)}`);
  }
  if (requesterId !== undefined && !requesterId) {
    throw refuse('null_actor', context, requesterId, undefined, options);
  }
  const distinct = new Set<string>();
  for (const approverId of approverIds) {
    if (!approverId) throw refuse('null_actor', context, requesterId, approverId, options);
    if (approverId !== requesterId) distinct.add(approverId);
  }
  if (distinct.size < min) {
    throw refuse('insufficient_approvers', context, requesterId, undefined, options);
  }
}

/**
 * True when `roles` grant approval: an approver role and no service role. Unknown roles grant nothing.
 * The requester check is separate (see {@link assertCanApprove}).
 */
export function canApprove(roles: readonly string[]): boolean {
  if (roles.some((role) => (SERVICE_ROLES as readonly string[]).includes(role))) return false;
  return roles.some((role) => (APPROVER_ROLES as readonly string[]).includes(role));
}

/**
 * Full approver check: a missing approver is `null_actor`, the requester is `requester_equals_approver`, and a
 * principal without an approver role (or with a service role) is `ineligible_approver`.
 */
export function assertCanApprove(
  approverId: string | null | undefined,
  roles: readonly string[],
  requesterId: string | null | undefined,
  context: string,
  options: SodOptions = {},
): void {
  if (!approverId) throw refuse('null_actor', context, requesterId, approverId, options);
  if (requesterId && approverId === requesterId) {
    throw refuse('requester_equals_approver', context, requesterId, approverId, options);
  }
  if (!canApprove(roles)) {
    throw refuse('ineligible_approver', context, requesterId, approverId, options);
  }
}
