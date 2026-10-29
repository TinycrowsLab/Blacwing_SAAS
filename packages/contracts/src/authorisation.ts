import { z } from 'zod';

/**
 * Standing-authorisation (SA) lifecycle values (AUTHZ-001, CONTEXT_PACK §7, §8.1). This file is the
 * single source for the `standing_authorisations.status` check constraint in `@blackwing/db` and for the
 * state machine in `@blackwing/domain`, so the two cannot drift.
 *
 * The SA's `max_intrusiveness` is constrained to `SELECTABLE_INTRUSIVENESS_CLASSES` (intrusiveness.ts):
 * `destructive` is never a valid ceiling (§8.3).
 */

/** Lifecycle of a standing authorisation. `expired` and `revoked` are terminal. */
export const SA_STATUSES = ['draft', 'pending_approval', 'active', 'expired', 'revoked'] as const;
export const saStatusSchema = z.enum(SA_STATUSES);
export type SaStatus = z.infer<typeof saStatusSchema>;
