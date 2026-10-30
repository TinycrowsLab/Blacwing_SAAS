import { z } from 'zod';

import { auditActionSchema } from './actions.js';

/**
 * Per-subscription SIEM export filters (AUDIT-004): `actions` is an allowlist (absent means every action) and
 * `excludeActions` a denylist applied after it. Both name catalogue actions, so a typo fails validation instead of
 * silently exporting nothing. A filter only narrows what leaves the tenant; it never moves the cursor.
 */

/** Longest allowlist or denylist a subscription may carry. */
export const AUDIT_EXPORT_FILTERS_MAX = 200;

export const auditExportFiltersSchema = z.strictObject({
  actions: z.array(auditActionSchema).max(AUDIT_EXPORT_FILTERS_MAX).optional(),
  excludeActions: z.array(auditActionSchema).max(AUDIT_EXPORT_FILTERS_MAX).optional(),
});
export type AuditExportFilters = z.infer<typeof auditExportFiltersSchema>;
