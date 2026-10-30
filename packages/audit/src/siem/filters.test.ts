import { describe, expect, it } from 'vitest';

import { matchesAuditExportFilters, parseAuditExportFilters } from './filters.js';

describe('audit export filters', () => {
  it('an empty filter passes every action', () => {
    expect(matchesAuditExportFilters({}, 'gate2.decided')).toBe(true);
  });

  it('an allowlist passes only the named actions', () => {
    const filters = parseAuditExportFilters({ actions: ['kill.triggered'] });
    expect(matchesAuditExportFilters(filters, 'kill.triggered')).toBe(true);
    expect(matchesAuditExportFilters(filters, 'gate2.decided')).toBe(false);
  });

  it('a denylist removes the named actions and an empty allowlist passes nothing', () => {
    expect(
      matchesAuditExportFilters(
        parseAuditExportFilters({ excludeActions: ['gate2.decided'] }),
        'gate2.decided',
      ),
    ).toBe(false);
    expect(
      matchesAuditExportFilters(parseAuditExportFilters({ actions: [] }), 'gate2.decided'),
    ).toBe(false);
  });

  it('the denylist wins over the allowlist when both name an action', () => {
    const filters = parseAuditExportFilters({
      actions: ['kill.triggered'],
      excludeActions: ['kill.triggered'],
    });
    expect(matchesAuditExportFilters(filters, 'kill.triggered')).toBe(false);
  });

  it('rejects unknown actions, unknown keys and non-array values (fail closed, no silent export-all)', () => {
    expect(() => parseAuditExportFilters({ actions: ['made.up'] })).toThrow();
    expect(() => parseAuditExportFilters({ actions: 'kill.triggered' })).toThrow();
    expect(() => parseAuditExportFilters({ allow: ['kill.triggered'] })).toThrow();
    expect(() => parseAuditExportFilters(null)).toThrow();
  });
});
