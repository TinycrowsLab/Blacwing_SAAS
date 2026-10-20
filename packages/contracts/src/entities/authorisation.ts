import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isBefore,
  isoDateTimeSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/** Intrusiveness classes, §3.5 (F4), ordered from least to most intrusive. */
export const intrusivenessSchema = z.enum([
  'passive',
  'active_safe',
  'state_changing',
  'destructive',
]);
export type Intrusiveness = z.infer<typeof intrusivenessSchema>;

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

const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * One include/exclude scope rule (hosts, paths, ports, methods; §7 `scope_rules`). The matcher and its
 * precedence rules belong to the scope-rule model (#566); this is only the stored shape.
 */
export const scopeRuleSchema = z.strictObject({
  host: z.string().min(1).max(LIMITS.hostnameMax),
  paths: z.array(z.string().startsWith('/')).optional(),
  ports: z.array(z.int().min(1).max(LIMITS.portMax)).optional(),
  methods: z.array(z.enum(HTTP_METHODS)).optional(),
});
export type ScopeRule = z.infer<typeof scopeRuleSchema>;

export const scopeRulesSchema = z.strictObject({
  include: z.array(scopeRuleSchema).min(1),
  exclude: z.array(scopeRuleSchema),
});
export type ScopeRules = z.infer<typeof scopeRulesSchema>;

/** Run budgets (§7 `runs.budgets`): cost cap in USD, request cap and wall-clock cap. */
export const runBudgetsSchema = z.strictObject({
  costCapUsd: z.number().positive().max(LIMITS.costCapUsdMax),
  maxRequests: z.int().positive(),
  maxDurationMs: z.int().positive(),
});
export type RunBudgets = z.infer<typeof runBudgetsSchema>;

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
    scopeRules: scopeRulesSchema,
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
