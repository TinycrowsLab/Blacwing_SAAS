import { z } from 'zod';

import { assessmentRequestPublicIdSchema } from './assessment-request-api.js';

/**
 * Wire contract of the pre-submit dry run (#579, POST /v1/assessment-requests/:id/preflight). The report is
 * read-only: no login, no SOC notice and no target traffic happen, so every check here is a read of our own
 * records. Strict: the wire shape is exactly what the API builds, never an extra field.
 */

const evidenceValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const preflightCheckResultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: z.enum(['blocking', 'warning']),
    status: z.enum(['pass', 'fail', 'skip']),
    detail: z.string(),
    code: z.string().min(1).optional(),
    remediation: z.string().min(1).optional(),
    evidence: z.record(z.string(), evidenceValueSchema).optional(),
  })
  .strict();

export const preflightDryRunResponseSchema = z
  .object({
    requestId: assessmentRequestPublicIdSchema,
    dryRun: z.literal(true),
    ok: z.boolean(),
    results: z.array(preflightCheckResultSchema),
    blockingFailures: z.array(z.string().min(1)),
  })
  .strict();

export type PreflightCheckResultView = z.infer<typeof preflightCheckResultSchema>;
export type PreflightDryRunResponse = z.infer<typeof preflightDryRunResponseSchema>;
