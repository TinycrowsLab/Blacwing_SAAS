import { randomUUID } from 'node:crypto';

import { ROLES, type Role } from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';

import type { PersonaPrincipal } from './ports.js';

export const TENANT_A = randomUUID();
export const TENANT_B = randomUUID();

export function principal(
  roles: readonly Role[],
  over: Partial<PersonaPrincipal> = {},
): PersonaPrincipal {
  return {
    type: 'user',
    id: randomUUID(),
    tenantId: TENANT_A,
    roles,
    ...over,
  };
}

/** Every tenant role that does not hold the permission. Derived from the matrix, not hard-coded. */
export function rolesWithout(permission: Parameters<typeof hasPermission>[1]): Role[] {
  return ROLES.filter((role) => !hasPermission([role], permission));
}
