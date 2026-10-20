import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  cweIdSchema,
  isoDateTimeSchema,
  labelSchema,
  sha256HexSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/** Finding lifecycle statuses, §3.4 (validation, triage and remediation). */
export const findingStatusSchema = z.enum([
  'candidate',
  'validating',
  'confirmed',
  'suspected',
  'released',
  'rejected_false_positive',
  'duplicate',
  'accepted_risk',
  'fixed',
  'returned',
]);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

/** Statuses a finding only reaches after a human released it (Gate 3). */
export const RELEASED_FINDING_STATUSES: readonly FindingStatus[] = Object.freeze([
  'released',
  'fixed',
  'returned',
]);

/** Per-asset baseline diff (§3.4). */
export const baselineStatusSchema = z.enum(['new', 'open', 'fixed', 'returned', 'not_retested']);
export type BaselineStatus = z.infer<typeof baselineStatusSchema>;

/** CVSS v4.0 vector and score, with an optional 3.1 vector (§7 `severity`). */
export const severitySchema = z.strictObject({
  cvssV4Vector: z.string().regex(/^CVSS:4\.0\/AV:[NALP]\/\S+$/, 'must be a CVSS:4.0 vector'),
  cvssV4Score: z.number().min(0).max(LIMITS.cvssScoreMax),
  cvssV31Vector: z
    .string()
    .regex(/^CVSS:3\.1\/AV:[NALP]\/\S+$/, 'must be a CVSS:3.1 vector')
    .nullable(),
});
export type Severity = z.infer<typeof severitySchema>;

/** Where the finding is: HTTP method + URL template + parameter, and/or file:line for white box. */
export const findingLocationSchema = z.strictObject({
  method: z
    .string()
    .regex(/^[A-Z]+$/, 'must be an upper-case HTTP method')
    .nullable(),
  urlTemplate: z.string().min(1).max(LIMITS.urlMax).nullable(),
  parameter: z.string().min(1).max(LIMITS.parameterMax).nullable(),
  file: z.string().min(1).max(LIMITS.filePathMax).nullable(),
  line: z.int().positive().nullable(),
});
export type FindingLocation = z.infer<typeof findingLocationSchema>;

/** An `accepted_risk` triage decision needs a reason and an expiry (§3.4). */
export const acceptedRiskSchema = z.strictObject({
  reason: z.string().min(1).max(LIMITS.reasonMax),
  expiresAt: isoDateTimeSchema,
});
export type AcceptedRisk = z.infer<typeof acceptedRiskSchema>;

/**
 * A finding, §7 `findings`. The findings issue (#739) owns persistence and extends this contract.
 *
 * Rules: `released`, `fixed` and `returned` findings record who released them and when; `accepted_risk`
 * carries its reason and expiry (and only that status does); the location names at least one of a URL
 * template or a file.
 */
export const findingSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    runId: uuidV7Schema,
    assetId: uuidV7Schema,
    fingerprint: sha256HexSchema,
    title: labelSchema,
    class: z.string().min(1).max(LIMITS.shortTextMax),
    cweId: cweIdSchema,
    owaspCategory: z.string().min(1).max(LIMITS.shortTextMax),
    severity: severitySchema,
    location: findingLocationSchema,
    status: findingStatusSchema,
    baselineStatus: baselineStatusSchema.nullable(),
    firstSeenRunId: uuidV7Schema,
    lastSeenRunId: uuidV7Schema,
    /** Validator confidence in [0, 1]. */
    confidence: z.number().min(0).max(1),
    acceptedRisk: acceptedRiskSchema.nullable(),
    releasedBy: uuidV7Schema.nullable(),
    releasedAt: isoDateTimeSchema.nullable(),
    ...timestampsShape,
  })
  .superRefine((finding, ctx) => {
    checkTimestamps(finding, ctx);
    const released = RELEASED_FINDING_STATUSES.includes(finding.status);
    if (released && (finding.releasedBy === null || finding.releasedAt === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['releasedBy'],
        message: `a ${finding.status} finding records its release`,
      });
    }
    if ((finding.status === 'accepted_risk') !== (finding.acceptedRisk !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['acceptedRisk'],
        message: 'acceptedRisk is set exactly when the status is accepted_risk',
      });
    }
    if (finding.location.urlTemplate === null && finding.location.file === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'a location needs a URL template or a file',
      });
    }
  });
export type Finding = z.infer<typeof findingSchema>;
