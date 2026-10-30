import { describe, expect, it } from 'vitest';

import { TenantContextMissingError } from '@blackwing/errors';

import { resolveRetention, type RetentionPolicyRow } from './resolve.js';

const TENANT = '0190f6a2-7b1c-7d2e-8f3a-123456789abc';
const OTHER = '0190f6a2-7b1c-7d2e-8f3a-abcdef012345';

const row = (overrides: Partial<RetentionPolicyRow> = {}): RetentionPolicyRow => ({
  tenantId: TENANT,
  dataClass: 'evidence',
  retentionDays: 120,
  minRetentionDays: 30,
  enabled: true,
  legalHoldOverrides: false,
  ...overrides,
});

describe('resolveRetention', () => {
  it('uses the tenant value when a stored row enables the class', () => {
    expect(resolveRetention([row()], TENANT, 'evidence')).toEqual({
      tenantId: TENANT,
      dataClass: 'evidence',
      retentionDays: 120,
      minRetentionDays: 30,
      source: 'tenant',
      legalHoldOverrides: false,
    });
  });

  it('falls back to the platform default when no row exists (never keep forever)', () => {
    const effective = resolveRetention([], TENANT, 'findings');
    expect(effective).toMatchObject({
      retentionDays: 730,
      minRetentionDays: 90,
      source: 'platform_default',
    });
  });

  it('ignores rows that belong to another tenant (tenant isolation)', () => {
    const effective = resolveRetention(
      [row({ tenantId: OTHER, retentionDays: 31 })],
      TENANT,
      'evidence',
    );
    expect(effective.source).toBe('platform_default');
    expect(effective.retentionDays).toBe(365);
  });

  it('runs a disabled class at the floor, never below and never forever', () => {
    expect(
      resolveRetention([row({ enabled: false, retentionDays: 365 })], TENANT, 'evidence'),
    ).toMatchObject({
      retentionDays: 30,
      minRetentionDays: 30,
      source: 'floor',
    });
  });

  it('raises a stored value below the floor up to the floor (fail toward keeping)', () => {
    expect(resolveRetention([row({ retentionDays: 3 })], TENANT, 'evidence').retentionDays).toBe(
      30,
    );
  });

  it('never honours legal_hold_overrides, even when a row sets it', () => {
    const effective = resolveRetention(
      [row({ legalHoldOverrides: true, retentionDays: 31 })],
      TENANT,
      'evidence',
    );
    expect(effective.legalHoldOverrides).toBe(false);
    expect(effective.retentionDays).toBe(31);
  });

  it('applies the platform floor when a row stores a weaker floor than the platform', () => {
    expect(
      resolveRetention(
        [row({ dataClass: 'findings', minRetentionDays: 1, retentionDays: 2 })],
        TENANT,
        'findings',
      ),
    ).toMatchObject({ retentionDays: 90, minRetentionDays: 90 });
  });

  it('fails closed without a tenant id', () => {
    expect(() => resolveRetention([], '  ', 'logs')).toThrow(TenantContextMissingError);
  });
});
