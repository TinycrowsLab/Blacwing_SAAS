import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_PAGE,
  DASHBOARD_UNCATEGORISED,
  DASHBOARD_UNSCORED,
  dashboardFindingFilterSchema,
  dashboardSeveritySchema,
  dashboardTrendBucketSchema,
} from './dashboard.js';

const ASSET = '0198f0a0-0000-7000-8000-000000000001';

describe('dashboardFindingFilterSchema', () => {
  it('accepts an empty filter and a filter over every field', () => {
    expect(dashboardFindingFilterSchema.parse({})).toEqual({});
    expect(
      dashboardFindingFilterSchema.parse({
        assetIds: [ASSET],
        severities: ['critical', 'info'],
        owaspCategories: ['A01', 'A10'],
        cweIds: ['CWE-89'],
        statuses: ['confirmed'],
        baselineStatuses: ['new', 'not_retested'],
        runIds: [ASSET],
        releasedOnly: true,
      }),
    ).toMatchObject({ releasedOnly: true, owaspCategories: ['A01', 'A10'] });
  });

  it('refuses a field it does not know, so a tenant id cannot ride along in the filter', () => {
    expect(dashboardFindingFilterSchema.safeParse({ tenantId: ASSET }).success).toBe(false);
  });

  it('refuses a severity outside the CVSS v4.0 bands, and an OWASP category outside A01..A10', () => {
    expect(dashboardFindingFilterSchema.safeParse({ severities: ['severe'] }).success).toBe(false);
    expect(dashboardFindingFilterSchema.safeParse({ owaspCategories: ['A11'] }).success).toBe(
      false,
    );
    expect(dashboardFindingFilterSchema.safeParse({ owaspCategories: ['A00'] }).success).toBe(
      false,
    );
  });

  it('refuses a malformed asset id and a malformed CWE id', () => {
    expect(dashboardFindingFilterSchema.safeParse({ assetIds: ['not-an-id'] }).success).toBe(false);
    expect(dashboardFindingFilterSchema.safeParse({ cweIds: ['CWE-0'] }).success).toBe(false);
  });

  it('refuses more OWASP categories than exist, and an over-long list of assets', () => {
    expect(
      dashboardFindingFilterSchema.safeParse({
        owaspCategories: Array.from({ length: 11 }, () => 'A01'),
      }).success,
    ).toBe(false);
    expect(
      dashboardFindingFilterSchema.safeParse({ assetIds: Array.from({ length: 201 }, () => ASSET) })
        .success,
    ).toBe(false);
  });

  it('refuses a non-boolean releasedOnly', () => {
    expect(dashboardFindingFilterSchema.safeParse({ releasedOnly: 'yes' }).success).toBe(false);
  });
});

describe('dashboard enums and page sizes', () => {
  it('names the five severity buckets and the two trend buckets', () => {
    expect(dashboardSeveritySchema.options).toEqual(['critical', 'high', 'medium', 'low', 'info']);
    expect(dashboardTrendBucketSchema.options).toEqual(['day', 'week']);
  });

  it('keeps the explicit buckets for uncategorised and unscored findings, and a page of at most 200', () => {
    expect(DASHBOARD_UNCATEGORISED).toBe('uncategorised');
    expect(DASHBOARD_UNSCORED).toBe('unscored');
    expect(DASHBOARD_PAGE).toEqual({ defaultSize: 50, maxSize: 200 });
  });
});
