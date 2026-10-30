import { z } from 'zod';

import { isRole, ROLE_PERMISSIONS, ROLES, type Role, roleSchema } from './roles.js';

import type { Permission } from './permissions.js';

/**
 * Service accounts (RBAC-005, CONTEXT_PACK §1.2, §7, §8.4): non-human tenant principals that own API/CI
 * tokens. They carry a constrained role set and are managed through a tenant-scoped CRUD API that writes
 * an audit event for every change. Token issuance (RBAC-006) and CI binding (RBAC-008) reference them.
 *
 * Least privilege and separation of duties (§8.4): a service account can never hold a role that grants
 * an approval or an administrative permission, so a CI identity can never satisfy an approver requirement
 * (Gate 1/2/3) or administer the tenant. The rule is derived from the role matrix (`roles.ts`), not
 * hand-maintained per role, so a future grant that carries one of these permissions is refused at once.
 */

/** Lifecycle of a service account. A disabled account authenticates nothing (see `isServiceAccountUsable`). */
export const SERVICE_ACCOUNT_STATUSES = Object.freeze(['active', 'disabled'] as const);
export const serviceAccountStatusSchema = z.enum(SERVICE_ACCOUNT_STATUSES);
export type ServiceAccountStatus = z.infer<typeof serviceAccountStatusSchema>;

/** Permissions a service account may never be granted: approvals (§8.4) and tenant administration. */
export const SERVICE_ACCOUNT_DENIED_PERMISSIONS: readonly Permission[] = Object.freeze([
  'sa:approve',
  'testplan:approve',
  'gate:decide',
  'finding:release',
  'member:assign',
  'policy:write',
  'settings:write',
  'secret:write',
] as const);

/** True when `role` grants no denied permission, i.e. a service account may hold it. */
export function isServiceAccountRoleAssignable(role: Role): boolean {
  return ROLE_PERMISSIONS[role].every(
    (permission) => !SERVICE_ACCOUNT_DENIED_PERMISSIONS.includes(permission),
  );
}

/** The roles a service account may hold, in catalogue order. Derived from the matrix. */
export const SERVICE_ACCOUNT_ROLES: readonly Role[] = Object.freeze(
  ROLES.filter((role) => isServiceAccountRoleAssignable(role)),
);

/** A role a service account may hold. Anything else (approval or admin roles) is rejected at write time. */
export const serviceAccountRoleSchema = roleSchema.refine(isServiceAccountRoleAssignable, {
  message: 'role_not_assignable_to_service_account',
});

/** A service account is usable only while active; a disabled one fails closed for every token. */
export function isServiceAccountUsable(account: {
  readonly status: ServiceAccountStatus;
}): boolean {
  return account.status === 'active';
}

export const SERVICE_ACCOUNT_NAME_MAX = 100;
export const SERVICE_ACCOUNT_DESCRIPTION_MAX = 500;

/** Printable, non-blank name, unique per tenant (the uniqueness is enforced by the database). */
export const serviceAccountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SERVICE_ACCOUNT_NAME_MAX)
  .refine((value) => !/[\p{Cc}]/u.test(value), { message: 'name_contains_control_characters' });

const descriptionSchema = z.string().trim().max(SERVICE_ACCOUNT_DESCRIPTION_MAX);

/** A role list with no duplicates. An empty list is allowed: the account then holds no permission. */
const uniqueRolesSchema = z
  .array(serviceAccountRoleSchema)
  .max(ROLES.length)
  .refine((roles) => new Set(roles).size === roles.length, { message: 'roles_must_be_unique' });

/** `POST /v1/service-accounts` body. `ownerUserId` must be a member of the tenant (checked on write). */
export const serviceAccountCreateSchema = z.strictObject({
  name: serviceAccountNameSchema,
  description: descriptionSchema.optional(),
  roles: uniqueRolesSchema.default([]),
  ownerUserId: z.uuid(),
});
export type ServiceAccountCreateInput = z.input<typeof serviceAccountCreateSchema>;

/**
 * `PATCH /v1/service-accounts/{id}` body: at least one field. `ownerUserId` and the tenant are not
 * writable. Setting `status` to `disabled` is the same as `DELETE` (a soft disable, never a hard delete).
 */
export const serviceAccountUpdateSchema = z
  .strictObject({
    name: serviceAccountNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    roles: uniqueRolesSchema.optional(),
    status: serviceAccountStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at_least_one_field_required',
  });
export type ServiceAccountUpdateInput = z.input<typeof serviceAccountUpdateSchema>;

/** A service account as the API returns it. */
export const serviceAccountSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  roles: z.array(roleSchema),
  ownerUserId: z.uuid(),
  status: serviceAccountStatusSchema,
  stateVersion: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** Type guard for a stored role value (used when reading rows back). */
export function isServiceAccountRole(value: unknown): value is Role {
  return isRole(value) && isServiceAccountRoleAssignable(value);
}

/** `GET /v1/service-accounts` query: keyset cursor and page size (1 to 200, default 50). */
const LIST_CURSOR_MAX = 512;
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;

export const serviceAccountListQuerySchema = z.strictObject({
  cursor: z.string().max(LIST_CURSOR_MAX).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(LIST_LIMIT_MIN)
    .max(LIST_LIMIT_MAX)
    .default(LIST_LIMIT_DEFAULT),
});

/** Path parameter of the `/v1/service-accounts/{id}` routes. */
export const serviceAccountIdParamSchema = z.strictObject({ id: z.uuid() });
