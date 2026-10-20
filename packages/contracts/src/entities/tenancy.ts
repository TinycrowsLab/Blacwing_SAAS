import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { checkTimestamps, labelSchema, timestampsShape, uuidV7Schema } from '../primitives.js';

/** `tenants.status` (§7). */
export const tenantStatusSchema = z.enum(['active', 'suspended', 'deleted']);
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
export const userStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** A user, §7 `users`. Identity lives in Keycloak; `keycloakSub` is the OIDC subject. */
export const userSchema = z
  .strictObject({
    id: uuidV7Schema,
    keycloakSub: z.string().min(1).max(LIMITS.subjectMax),
    email: z.email(),
    name: labelSchema,
    status: userStatusSchema,
    ...timestampsShape,
  })
  .superRefine(checkTimestamps);
export type User = z.infer<typeof userSchema>;
