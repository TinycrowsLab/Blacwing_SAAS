import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { uuidV7Schema } from '../primitives.js';
import { evidenceRefsSchema, nfcTextSchema, oracleBindingTypeSchema } from './oracle.js';

/** Upper bounds on the replay loop: a flaky candidate is retried a bounded number of times, never forever. */
export const MAX_VALIDATION_ATTEMPTS = 10;
export const MAX_REPLAY_MS = 3_600_000;

/** `confirmed` is proven by the oracle and the negative control; `suspected` is recorded but not proven (F17). */
export const VALIDATION_OUTCOMES = ['confirmed', 'suspected'] as const;
export const validationOutcomeSchema = z.enum(VALIDATION_OUTCOMES);
export type ValidationOutcome = z.infer<typeof validationOutcomeSchema>;

/**
 * The validator's verdict on one candidate. Rules: `confirmed` requires the positive control to fire, the negative
 * control to stay clean and at least one piece of evidence; `suspected` carries the reason it could not be proven.
 */
export const validationResultSchema = z
  .strictObject({
    candidateId: uuidV7Schema,
    outcome: validationOutcomeSchema,
    oracleType: oracleBindingTypeSchema,
    positiveFired: z.boolean(),
    negativeControlClean: z.boolean(),
    reason: nfcTextSchema(LIMITS.reasonMax),
    evidenceRefs: evidenceRefsSchema,
    replayMs: z.int().min(0).max(MAX_REPLAY_MS),
    attempts: z.int().min(1).max(MAX_VALIDATION_ATTEMPTS),
    flaky: z.boolean(),
  })
  .superRefine((result, ctx) => {
    if (result.outcome !== 'confirmed') return;
    if (!result.positiveFired || !result.negativeControlClean) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message:
          'a confirmed result needs the oracle to fire and the negative control to stay clean',
      });
    }
    if (result.evidenceRefs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'a confirmed result needs at least one evidence reference',
      });
    }
  });
export type ValidationResult = z.infer<typeof validationResultSchema>;
