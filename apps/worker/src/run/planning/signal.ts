import { z } from 'zod';

import { LIMITS } from '@blackwing/contracts';

const actorAndVersion = {
  actorId: z.string().min(1).max(LIMITS.subjectMax),
  planVersion: z.int().min(1),
};

/**
 * The `gate1Decision` signal is validated at the activity boundary (CLAUDE.md: every external input is
 * parsed with Zod). Anything that does not parse is refused, never interpreted: a gate fails closed.
 */
export const gate1DecisionSignalSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    ...actorAndVersion,
    decision: z.literal('approved'),
    reason: z.string().min(1).max(LIMITS.reasonMax).optional(),
  }),
  z.strictObject({
    ...actorAndVersion,
    decision: z.literal('rejected'),
    next: z.enum(['replan', 'cancel']),
    reason: z.string().trim().min(1).max(LIMITS.reasonMax),
  }),
]);
