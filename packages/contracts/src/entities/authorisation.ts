import { z } from 'zod';

import { type RunBudget, runBudgetSchema } from '../budget.js';
import { type IntrusivenessClass, intrusivenessClassSchema } from '../intrusiveness.js';
import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isBefore,
  isoDateTimeSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';
import { scopeRulesSchema } from '../scope.js';

/**
 * Intrusiveness classes, §3.5 (F4), ordered from least to most intrusive. Defined once in
 * `../intrusiveness.ts` (SCOPE-003); these names are kept as aliases for the entity schemas.
 */
export const intrusivenessSchema = intrusivenessClassSchema;
export type Intrusiveness = IntrusivenessClass;

/**
 * The classes a standing authorisation may grant. `destructive` is hard-blocked by the platform
 * baseline policy (§8.3), so an SA can never carry it.
 */
export const authorisableIntrusivenessSchema = intrusivenessSchema.exclude(['destructive']);
export type AuthorisableIntrusiveness = z.infer<typeof authorisableIntrusivenessSchema>;

/** `standing_authorisations.status` (§7). */
export const standingAuthorisationStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'active',
  'expired',
  'revoked',
]);
export type StandingAuthorisationStatus = z.infer<typeof standingAuthorisationStatusSchema>;

/**
 * `scope_rules` of an SA (§7): the canonical ordered include/exclude model from `../scope.ts`
 * (SCOPE-002, #566). An SA must include something, so it needs at least one `include` rule.
 */
export const standingScopeRulesSchema = scopeRulesSchema.refine(
  (set) => set.rules.some((rule) => rule.effect === 'include'),
  { message: 'SCOPE_INVALID_RULE', path: ['rules'] },
);

/**
 * Run budgets (§7 `runs.budgets`): cost cap in USD, request cap and wall-clock cap. Defined once in
 * `../budget.ts` (SCOPE-004); kept here as an alias for the entity schemas.
 */
export const runBudgetsSchema = runBudgetSchema;
export type RunBudgets = RunBudget;

/** A test window: a cron expression evaluated in an IANA time zone, open for `durationMs`. */
export const testWindowSchema = z.strictObject({
  cron: z.string().min(1).max(LIMITS.shortTextMax),
  timezone: z.string().min(1).max(LIMITS.timezoneMax),
  durationMs: z.int().positive(),
});
export type TestWindow = z.infer<typeof testWindowSchema>;

/**
 * A standing authorisation (SA), §7 `standing_authorisations`.
 *
 * Invariants carried by the contract itself:
 * - `maxIntrusiveness` can never be `destructive` (§8.3);
 * - `approverId` differs from `requesterId` (separation of duties, §8.4);
 * - `expiresAt` is after `validFrom`;
 * - an `active` SA is approved and signed (approver, signature, signing key present);
 * - a `revoked` SA records why.
 */
export const standingAuthorisationSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    assetIds: z.array(uuidV7Schema).min(1),
    scopeRules: standingScopeRulesSchema,
    maxIntrusiveness: authorisableIntrusivenessSchema,
    preApprovedTestClasses: z.array(z.string().min(1).max(LIMITS.shortTextMax)),
    defaultBudgets: runBudgetsSchema,
    testWindows: z.array(testWindowSchema),
    validFrom: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    requesterId: uuidV7Schema,
    approverId: uuidV7Schema.nullable(),
    /** JWS over the JCS-canonical body (#375). */
    signature: z.string().min(1).nullable(),
    signingKeyId: z.string().min(1).nullable(),
    status: standingAuthorisationStatusSchema,
    revocationReason: z.string().min(1).max(LIMITS.reasonMax).nullable(),
    ...timestampsShape,
  })
  .superRefine((sa, ctx) => {
    checkTimestamps(sa, ctx);
    if (!isBefore(sa.validFrom, sa.expiresAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be after validFrom',
      });
    }
    if (sa.approverId !== null && sa.approverId === sa.requesterId) {
      ctx.addIssue({
        code: 'custom',
        path: ['approverId'],
        message: 'the approver must not be the requester',
      });
    }
    if (
      sa.status === 'active' &&
      (sa.approverId === null || sa.signature === null || sa.signingKeyId === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'an active SA must be approved and signed',
      });
    }
    if (sa.status === 'revoked' && sa.revocationReason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['revocationReason'],
        message: 'a revoked SA must record a reason',
      });
    }
  });
export type StandingAuthorisation = z.infer<typeof standingAuthorisationSchema>;
