import { describe, expect, it } from 'vitest';

import { SURFACE_SUMMARY_QUERY } from './surface-queries.js';

describe('SURFACE_SUMMARY_QUERY', () => {
  it('is a named read-only query over the surface summary', () => {
    expect(SURFACE_SUMMARY_QUERY.text.startsWith('query SurfaceSummary(')).toBe(true);
    expect(SURFACE_SUMMARY_QUERY.text).toContain('surfaceSummary(runId: $runId)');
    expect(SURFACE_SUMMARY_QUERY.text).not.toMatch(/\bmutation\b/);
  });
});
