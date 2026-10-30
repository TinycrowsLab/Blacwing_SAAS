import { z } from 'zod';

import { hasPermission } from '@blackwing/domain';
import { ForbiddenError } from '@blackwing/errors';

import type { TestPlanMemberships } from './ports.js';
import type { Permission } from '@blackwing/contracts';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface TestPlanPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

const uuidSchema = z.uuid();

/**
 * The caller's roles in the tenant, when they hold `permission` there. No membership (or no roles) means no permission:
 * `ForbiddenError`. Shared by the plan editor and the plan validator so both answer the same way.
 */
export async function rolesWithPermission(
  memberships: TestPlanMemberships,
  principal: TestPlanPrincipal,
  permission: Permission,
): Promise<readonly string[]> {
  const userId = uuidSchema.safeParse(principal.actorId);
  const roles = userId.success ? await memberships.rolesOf(principal.tenantId, userId.data) : [];
  if (!hasPermission(roles, permission)) {
    throw new ForbiddenError('the caller may not use test plans here', {
      detail: `Missing permission ${permission} in this tenant.`,
    });
  }
  return roles;
}
