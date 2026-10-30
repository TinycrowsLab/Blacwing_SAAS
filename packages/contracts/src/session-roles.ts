import { z } from 'zod';

/**
 * Contracts of the role-switching session tools (AUTHLOGIC persona, #696; CONTEXT_PACK §4.6, §8.7).
 *
 * A specialist switches between role sessions by reference only. `roleId` names an injected session that the
 * egress gateway owns; the tool result carries the role id and a status, never a credential, cookie, token or
 * session handle. The result schemas are strict, so a backend that echoes anything else is refused.
 */

/** The statuses a role session can report. `expired` means the session must be refreshed or re-logged-in. */
export const ROLE_SESSION_STATUSES = Object.freeze(['live', 'expired', 'unavailable'] as const);
export const roleSessionStatusSchema = z.enum(ROLE_SESSION_STATUSES);
export type RoleSessionStatus = z.infer<typeof roleSessionStatusSchema>;

/** A role id: a lowercase slug, the same name the role matrix uses. Path-safe, so it can sit in a broker URL. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;
export const roleIdSchema = z.string().regex(ROLE_ID_PATTERN);

export const useRoleInputSchema = z.strictObject({ roleId: roleIdSchema });
export const checkSessionInputSchema = z.strictObject({ roleId: roleIdSchema });

/** The only fields a role-session answer may carry. Anything else (a token, a cookie) fails the schema. */
export const roleSessionResultSchema = z.strictObject({
  roleId: roleIdSchema,
  status: roleSessionStatusSchema,
});
export type RoleSessionResult = z.infer<typeof roleSessionResultSchema>;
