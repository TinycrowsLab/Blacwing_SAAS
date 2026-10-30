import { z } from 'zod';

import { uuidV7Schema } from './primitives.js';

/**
 * Per-role session store contracts (SESSION-004, CONTEXT_PACK §3.1, §8.1, §8.6, §8.7). A stored session is the
 * encrypted material of one login for one role of one asset in one run. The database CHECK constraints
 * (`packages/db/src/schema/role-sessions.ts`) repeat these lists, so the two cannot drift.
 */

/** Lifecycle of a stored session. Only `active` and `refreshing` material may be injected. */
export const STORED_SESSION_STATUSES = ['active', 'expired', 'revoked', 'refreshing'] as const;
export const storedSessionStatusSchema = z.enum(STORED_SESSION_STATUSES);
export type StoredSessionStatus = z.infer<typeof storedSessionStatusSchema>;

/** The statuses whose material is still valid for injection (fail closed for everything else). */
export const INJECTABLE_STORED_SESSION_STATUSES: readonly StoredSessionStatus[] = Object.freeze([
  'active',
  'refreshing',
]);

/** The kind of session artifact held (cookies, a bearer token, extra headers, or a browser storage state). */
export const STORED_SESSION_KINDS = ['cookie', 'bearer', 'header', 'storage'] as const;
export const storedSessionKindSchema = z.enum(STORED_SESSION_KINDS);
export type StoredSessionKind = z.infer<typeof storedSessionKindSchema>;

const BYTES_PER_KIB = 1024;
const MATERIAL_CAP_KIB = 64;
/** Cap on the plaintext session material of one role (64 KiB). Larger material is refused, never truncated. */
export const STORED_SESSION_MAX_MATERIAL_BYTES = MATERIAL_CAP_KIB * BYTES_PER_KIB;

/** A role name: letters, digits, `_`, `.`, `-`. No colon, so the Valkey mirror key stays unambiguous. */
export const storedSessionRoleNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'role name must be 1 to 64 of [A-Za-z0-9_.-]');

/** The scope a stored session is keyed by: `(tenant, run, asset, role)`. */
export const storedSessionKeySchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  assetId: uuidV7Schema,
  roleName: storedSessionRoleNameSchema,
});
export type StoredSessionKey = z.infer<typeof storedSessionKeySchema>;
