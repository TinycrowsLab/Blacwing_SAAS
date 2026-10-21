import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { checkTimestamps, labelSchema, timestampsShape, uuidV7Schema } from '../primitives.js';
import { roleSchema } from '../rbac/roles.js';

/** `tenants.status` (§7). */
export const TENANT_STATUSES = ['active', 'suspended', 'deleted'] as const;
export const tenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

/** URL-safe organisation slug: lowercase letters, digits and single hyphens, 3-63 characters. */
export const tenantSlugSchema = z
  .string()
  .min(LIMITS.slugMin)
  .max(LIMITS.slugMax)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase letters, digits and single hyphens');

/** A tenant (organisation), §7 `tenants`. */
export const tenantSchema = z
  .strictObject({
    id: uuidV7Schema,
    slug: tenantSlugSchema,
    name: labelSchema,
    status: tenantStatusSchema,
    /** Data region the tenant is pinned to, e.g. `eu-west-1`. */
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/, 'must look like an AWS region code'),
    plan: z.string().min(1).max(LIMITS.keyMax),
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type Tenant = z.infer<typeof tenantSchema>;

/** `users.status`. Users are global; tenant access comes from memberships. */
export const USER_STATUSES = ['active', 'suspended', 'deleted'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** A user, §7 `users`. Identity lives in Keycloak; `keycloakSub` is the OIDC subject. */
export const userSchema = z
  .strictObject({
    id: uuidV7Schema,
    keycloakSub: z.string().min(1).max(LIMITS.subjectMax),
    email: z.email(),
    /** `users.name` is nullable: Keycloak may not supply a display name. */
    name: labelSchema.nullable(),
    status: userStatusSchema,
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type User = z.infer<typeof userSchema>;

/**
 * A membership, §7 `memberships`: the (tenant, user) pair with the user's roles in that tenant.
 * An empty `roles` array means no permissions (RBAC enforces); roles are unique tenant roles.
 */
export const membershipSchema = z
  .strictObject({
    tenantId: uuidV7Schema,
    userId: uuidV7Schema,
    roles: z
      .array(roleSchema)
      .refine((roles) => new Set(roles).size === roles.length, 'roles must be unique'),
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type Membership = z.infer<typeof membershipSchema>;
