import { describe, expect, it } from 'vitest';

import { auditExportFiltersSchema, AUDIT_EXPORT_FILTERS_MAX } from './export-filters.js';

describe('audit export filters schema', () => {
  it('accepts catalogue actions only', () => {
    expect(auditExportFiltersSchema.parse({ actions: ['kill.triggered'] })).toEqual({
      actions: ['kill.triggered'],
    });
    expect(() => auditExportFiltersSchema.parse({ actions: ['made.up'] })).toThrow();
    expect(() => auditExportFiltersSchema.parse({ excludeActions: ['made.up'] })).toThrow();
  });

  it('is strict about keys and bounds the list length', () => {
    expect(() => auditExportFiltersSchema.parse({ allow: [] })).toThrow();
    const tooMany = Array.from({ length: AUDIT_EXPORT_FILTERS_MAX + 1 }, () => 'kill.triggered');
    expect(() => auditExportFiltersSchema.parse({ actions: tooMany })).toThrow();
  });
});
