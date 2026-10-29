import { z } from 'zod';

import { LIMITS } from '../limits.js';

/**
 * Gate decisions (AUTHZ, CONTEXT_PACK §7, §8.4, §8.8). One table and one write path are shared by Gate 1 (test
 * plan), Gate 2 (in-run escalation), Gate 3 (findings release) and the standing-authorisation approval. The enums
 * here are the wire and storage vocabulary; the database CHECK constraints mirror them.
 */

/** The gates a decision can belong to. Gates 1 and 2 are separation-of-duties gated; Gate 3 is not (§8.4). */
export type GateNumber = 1 | 2 | 3;
const GATE_COUNT = 3;
export const GATE_NUMBERS: readonly GateNumber[] = Array.from(
  { length: GATE_COUNT },
  (_, index) => (index + 1) as GateNumber,
);
export const gateNumberSchema = z.literal(GATE_NUMBERS);

/** What a decision is about. `sa` is the standing-authorisation approval. */
export const GATE_SUBJECT_TYPES = ['sa', 'test_plan', 'run', 'exception', 'finding'] as const;
export type GateSubjectType = (typeof GATE_SUBJECT_TYPES)[number];
export const gateSubjectTypeSchema = z.enum(GATE_SUBJECT_TYPES);

/** Outcome of a decision. `auto_approved` is the only outcome of a system (automatic) decision. */
export const GATE_DECISIONS = ['approved', 'rejected', 'deferred', 'auto_approved'] as const;
export type GateDecision = (typeof GATE_DECISIONS)[number];
export const gateDecisionSchema = z.enum(GATE_DECISIONS);

/** Input of a gate decision. Ids are UUIDs; the tenant is the ambient tenant of the write, never an input. */
export const gateDecisionInputSchema = z.strictObject({
  gate: gateNumberSchema,
  subjectType: gateSubjectTypeSchema,
  subjectId: z.uuid(),
  decision: gateDecisionSchema,
  /** The person who asked for the subject to be decided. Needed for the SoD check of Gates 1 and 2. */
  requesterId: z.uuid().nullable(),
  /** The deciding principal. Null only for an automatic decision (`auto: true`). */
  actorId: z.uuid().nullable(),
  reason: z.string().trim().min(1).max(LIMITS.reasonMax).nullable(),
  decidedAt: z.date().nullable(),
  timeoutAt: z.date().nullable(),
  auto: z.boolean(),
});
export type GateDecisionInput = z.infer<typeof gateDecisionInputSchema>;
