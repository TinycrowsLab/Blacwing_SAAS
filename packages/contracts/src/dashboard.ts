// Dashboard read model contracts (DASH-001, CONTEXT_PACK §7, §9). The GraphQL dashboard resolvers
// (apps/api/src/dashboard) validate every client value with these schemas before any SQL runs. Shared by api and web.

import { z } from 'zod';

import { baselineStatusSchema, findingStatusSchema } from './entities/finding.js';
import { cweIdSchema, uuidV7Schema } from './primitives.js';

/** Severity bucket of a dashboard count: the CVSS v4.0 band, with a score of 0 reported as `info`. */
export const dashboardSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type DashboardSeverity = z.infer<typeof dashboardSeveritySchema>;

/** Group key of findings with no primary CWE or no OWASP category (an explicit bucket, never a null). */
export const DASHBOARD_UNCATEGORISED = 'uncategorised';
/** Group key of findings that no validator has scored yet (`severity` is null). */
export const DASHBOARD_UNSCORED = 'unscored';

/** Time bucket of a finding trend: UTC days or ISO weeks (Monday start). */
export const dashboardTrendBucketSchema = z.enum(['day', 'week']);
export type DashboardTrendBucket = z.infer<typeof dashboardTrendBucketSchema>;

/** Page sizes of the dashboard connection (CONTEXT_PACK §9: cursor pagination, maximum 200). */
export const DASHBOARD_PAGE = Object.freeze({ defaultSize: 50, maxSize: 200 });

/** Longest list one filter field may carry. */
const FILTER_LIST_MAX = 200;
/** The OWASP Top 10 has ten categories, A01 to A10. */
const OWASP_TOP10_COUNT = 10;
const owaspCategorySchema = z.string().regex(/^A(0[1-9]|10)$/, 'must look like A01..A10');

/**
 * Filters of the dashboard reads (FindingFilter of DASH-001). Each field narrows the result; fields combine with AND
 * and values inside one field combine with OR. `releasedOnly` keeps findings a human released at Gate 3.
 */
export const dashboardFindingFilterSchema = z.strictObject({
  assetIds: z.array(uuidV7Schema).max(FILTER_LIST_MAX).optional(),
  severities: z
    .array(dashboardSeveritySchema)
    .max(dashboardSeveritySchema.options.length)
    .optional(),
  owaspCategories: z.array(owaspCategorySchema).max(OWASP_TOP10_COUNT).optional(),
  cweIds: z.array(cweIdSchema).max(FILTER_LIST_MAX).optional(),
  statuses: z.array(findingStatusSchema).max(findingStatusSchema.options.length).optional(),
  baselineStatuses: z
    .array(baselineStatusSchema)
    .max(baselineStatusSchema.options.length)
    .optional(),
  runIds: z.array(uuidV7Schema).max(FILTER_LIST_MAX).optional(),
  releasedOnly: z.boolean().optional(),
});
export type DashboardFindingFilter = z.infer<typeof dashboardFindingFilterSchema>;
