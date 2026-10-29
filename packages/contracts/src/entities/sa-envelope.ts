import { z } from 'zod';

import { runBudgetSchema } from '../budget.js';
import { LIMITS } from '../limits.js';
import { isoDateTimeSchema, uuidV7Schema } from '../primitives.js';
import { scopeRulesSchema } from '../scope.js';
import {
  authorisableIntrusivenessSchema,
  type StandingAuthorisation,
  testWindowSchema,
} from './authorisation.js';

/** Version of the signed SA envelope layout. A layout change bumps it and the signed bytes with it. */
export const SA_ENVELOPE_VERSION = 1;

const sortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);

/**
 * The signed subset of a standing authorisation (#375, §7, §8.1). Only these fields are signed and
 * hashed. Status, signature, key id, revocation and timestamps of the row are not part of it.
 * Arrays are sorted and unique so one authorisation has exactly one canonical byte string.
 */
export const saEnvelopeSchema = z
  .strictObject({
    saId: uuidV7Schema,
    tenantId: uuidV7Schema,
    assetIds: z.array(uuidV7Schema).min(1),
    scopeRules: scopeRulesSchema,
    maxIntrusiveness: authorisableIntrusivenessSchema,
    preApprovedTestClasses: z.array(z.string().min(1).max(LIMITS.shortTextMax)),
    defaultBudgets: runBudgetSchema,
    testWindows: z.array(testWindowSchema),
    validFrom: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    requesterId: uuidV7Schema,
    /** `null` before approval. Canonicalised as `null`, never omitted, so pre and post approval bodies differ. */
    approverId: uuidV7Schema.nullable(),
    version: z.literal(SA_ENVELOPE_VERSION),
  })
  .superRefine((envelope, ctx) => {
    if (!sortedUnique(envelope.assetIds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assetIds'],
        message: 'assetIds must be sorted and unique',
      });
    }
    if (!sortedUnique(envelope.preApprovedTestClasses)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preApprovedTestClasses'],
        message: 'preApprovedTestClasses must be sorted and unique',
      });
    }
  });
export type SaEnvelope = z.infer<typeof saEnvelopeSchema>;

/**
 * Projects a standing authorisation onto its signed envelope. Identifier lists are sorted here so that
 * every producer yields the same canonical body for the same grant.
 */
export function projectSaEnvelope(sa: StandingAuthorisation): SaEnvelope {
  return saEnvelopeSchema.parse({
    saId: sa.id,
    tenantId: sa.tenantId,
    assetIds: [...sa.assetIds].sort(),
    scopeRules: sa.scopeRules,
    maxIntrusiveness: sa.maxIntrusiveness,
    preApprovedTestClasses: [...sa.preApprovedTestClasses].sort(),
    defaultBudgets: sa.defaultBudgets,
    testWindows: sa.testWindows,
    validFrom: sa.validFrom,
    expiresAt: sa.expiresAt,
    requesterId: sa.requesterId,
    approverId: sa.approverId,
    version: SA_ENVELOPE_VERSION,
  });
}
