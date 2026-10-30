import {
  type AuditAction,
  type AuditExportFilters,
  auditExportFiltersSchema,
} from '@blackwing/contracts';

/** Parses a stored filter object; throws a `ZodError` for anything outside the grammar. */
export function parseAuditExportFilters(raw: unknown): AuditExportFilters {
  return auditExportFiltersSchema.parse(raw);
}

/** Whether an event with `action` passes the filters. An empty filter object passes everything. */
export function matchesAuditExportFilters(
  filters: AuditExportFilters,
  action: AuditAction,
): boolean {
  if (filters.actions !== undefined && !filters.actions.includes(action)) return false;
  if (filters.excludeActions?.includes(action)) return false;
  return true;
}
