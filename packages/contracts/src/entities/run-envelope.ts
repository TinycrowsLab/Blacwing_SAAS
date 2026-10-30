import { z } from 'zod';

import { runBudgetSchema } from '../budget.js';
import { LIMITS } from '../limits.js';
import { isoDateTimeSchema, uuidV7Schema } from '../primitives.js';
import {
  standingScopeRulesSchema,
  testWindowSchema,
  authorisableIntrusivenessSchema,
} from './authorisation.js';
import { gate1RunIdSchema } from './gate1.js';

/**
 * The approved run envelope (#399, §8.1, §8.9): the signed statement of what one run is authorised to do.
 * The egress gateway and the agent sessions treat it as the single source of truth for scope, window and
 * allowed intrusiveness. It is produced when Gate 1 approves a plan and signed as an attached JWS over its
 * canonical (RFC 8785) bytes. Only these fields are signed and hashed.
 */

/** Largest number of assets one envelope may name (bounded scope, §8.1). */
const RUN_ENVELOPE_MAX_ASSETS = 500;
/** Largest number of approved test cases one envelope may name. */
const RUN_ENVELOPE_MAX_TEST_CASES = 500;
/** Largest number of test windows one envelope may carry. */
const RUN_ENVELOPE_MAX_TEST_WINDOWS = 50;
/**
 * Largest canonical body, in bytes, that is signed or verified. The scope rules dominate the size, so a
 * run whose envelope exceeds it is refused rather than signed (fail closed).
 */
const KIB = 1024;
const RUN_ENVELOPE_MAX_KIB = 64;
export const RUN_ENVELOPE_MAX_BYTES = RUN_ENVELOPE_MAX_KIB * KIB;
/** The `typ` of a run envelope JWS, so a token of another kind is never accepted as one. */
export const RUN_ENVELOPE_TYP = 'application/run-envelope+jcs';

const sortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);

/** `runEnvelopeSchema`: one approved run. Arrays are sorted and unique so one run has one canonical body. */
export const runEnvelopeSchema = z
  .strictObject({
    runId: gate1RunIdSchema,
    tenantId: uuidV7Schema,
    assetIds: z.array(uuidV7Schema).min(1).max(RUN_ENVELOPE_MAX_ASSETS),
    scopeRules: standingScopeRulesSchema,
    testWindows: z.array(testWindowSchema).max(RUN_ENVELOPE_MAX_TEST_WINDOWS),
    maxIntrusiveness: authorisableIntrusivenessSchema,
    approvedTestCaseIds: z
      .array(z.string().min(1).max(LIMITS.shortTextMax))
      .min(1)
      .max(RUN_ENVELOPE_MAX_TEST_CASES),
    budgets: runBudgetSchema,
    saId: uuidV7Schema,
    /** The standing authorisation's `expires_at`: verification refuses the envelope after it. */
    saExpiresAt: isoDateTimeSchema,
    /** The end of the run's test window; `null` when the run carries no window. Verification checks it too. */
    runWindowEndsAt: isoDateTimeSchema.nullable(),
    approvedPlanVersion: z.int().positive(),
    approverId: z.string().min(1).max(LIMITS.shortTextMax),
    approvedAt: isoDateTimeSchema,
    /** Re-approval after request-changes produces a new version; the previous hash is superseded. */
    envelopeVersion: z.int().positive(),
  })
  .superRefine((envelope, ctx) => {
    if (!sortedUnique(envelope.assetIds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetIds'],
        message: 'assetIds must be sorted and unique',
      });
    }
    if (!sortedUnique(envelope.approvedTestCaseIds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedTestCaseIds'],
        message: 'approvedTestCaseIds must be sorted and unique',
      });
    }
  });
export type RunEnvelope = z.infer<typeof runEnvelopeSchema>;
