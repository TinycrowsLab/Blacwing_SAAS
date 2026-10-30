import { z } from 'zod';

import { isoDateTimeSchema } from './primitives.js';

/**
 * Per-tenant, per-data-class retention policies (RETAIN-001, CONTEXT_PACK §7, §8.4, §8.8).
 *
 * The platform owns the defaults and the floors below. A tenant may shorten a class only down to its
 * floor and never below it; legal hold and Object Lock always win, so `legal_hold_overrides` is fixed
 * to `false` and no input can set it. The lists here are the single source for the `retention_policies`
 * check constraints in `@blackwing/db` and for the API schemas.
 */

/** Data classes a retention policy governs. Additive only: stored rows and sweeps refer to them by name. */
export const RETENTION_DATA_CLASSES = [
  'findings',
  'evidence',
  'logs',
  'transcripts',
  'reports',
  'oob_interactions',
] as const;
export const retentionDataClassSchema = z.enum(RETENTION_DATA_CLASSES);
export type RetentionDataClass = z.infer<typeof retentionDataClassSchema>;

export interface RetentionClassDefaults {
  /** Retention applied when a tenant has no policy for the class, and seeded for a new tenant. */
  readonly retentionDays: number;
  /** The platform minimum; a tenant can never set retention below it. */
  readonly minRetentionDays: number;
}

/** Platform defaults and floors per class, in days (retention is measured in UTC days from creation). */
export const RETENTION_DEFAULTS: Readonly<Record<RetentionDataClass, RetentionClassDefaults>> =
  Object.freeze({
    findings: { retentionDays: 730, minRetentionDays: 90 },
    evidence: { retentionDays: 365, minRetentionDays: 30 },
    logs: { retentionDays: 90, minRetentionDays: 30 },
    transcripts: { retentionDays: 180, minRetentionDays: 30 },
    reports: { retentionDays: 730, minRetentionDays: 90 },
    oob_interactions: { retentionDays: 30, minRetentionDays: 7 },
  });

/** Longest retention a tenant may request, in days (ten years). */
export const RETENTION_DAYS_MAX = 3650;

/** Largest number of policy entries one `PUT` may carry: one per class. */
export const RETENTION_POLICY_SET_MAX = RETENTION_DATA_CLASSES.length;

/** A policy as the API returns it. Classes without a stored row show the platform default. */
export const retentionPolicySchema = z.strictObject({
  dataClass: retentionDataClassSchema,
  retentionDays: z.int().min(1).max(RETENTION_DAYS_MAX),
  minRetentionDays: z.int().min(1),
  enabled: z.boolean(),
  legalHoldOverrides: z.literal(false),
  /** `null` when the platform default applies and no row has been written yet. */
  updatedAt: isoDateTimeSchema.nullable(),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const retentionPolicySetSchema = z.strictObject({
  policies: z.array(retentionPolicySchema).length(RETENTION_POLICY_SET_MAX),
});
export type RetentionPolicySet = z.infer<typeof retentionPolicySetSchema>;

/**
 * One entry of a `PUT`. `enabled: false` shortens the class to its floor (the lowest retention the
 * platform allows), so `retentionDays` must equal the floor. It never means "keep forever".
 */
export const retentionPolicyUpdateItemSchema = z.strictObject({
  dataClass: retentionDataClassSchema,
  retentionDays: z.int().min(1).max(RETENTION_DAYS_MAX),
  enabled: z.boolean(),
});
export type RetentionPolicyUpdateItem = z.infer<typeof retentionPolicyUpdateItemSchema>;

/** A `PUT` body: one to all classes, each at most once. Unlisted classes keep their current policy. */
export const retentionPolicyUpdateSchema = z
  .strictObject({
    policies: z.array(retentionPolicyUpdateItemSchema).min(1).max(RETENTION_POLICY_SET_MAX),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.policies.forEach((item, index) => {
      if (seen.has(item.dataClass)) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', index, 'dataClass'],
          message: 'each data class may appear once',
        });
      }
      seen.add(item.dataClass);
      const floor = RETENTION_DEFAULTS[item.dataClass].minRetentionDays;
      if (item.retentionDays < floor) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', index, 'retentionDays'],
          message: `retentionDays for ${item.dataClass} must be at least ${String(floor)} (platform floor)`,
        });
      } else if (!item.enabled && item.retentionDays !== floor) {
        ctx.addIssue({
          code: 'custom',
          path: ['policies', index, 'retentionDays'],
          message: `a disabled ${item.dataClass} policy must set retentionDays to its floor (${String(floor)})`,
        });
      }
    });
  });
export type RetentionPolicyUpdate = z.infer<typeof retentionPolicyUpdateSchema>;
