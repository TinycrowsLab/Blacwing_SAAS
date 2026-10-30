import { RETENTION_DEFAULTS, type RetentionDataClass } from '@blackwing/contracts';
import { TenantContextMissingError } from '@blackwing/errors';

/**
 * A stored `retention_policies` row, as the resolver needs it. `legalHoldOverrides` is read only so
 * the resolver can ignore it: legal hold always wins, whatever a row says (RETAIN-001).
 */
export interface RetentionPolicyRow {
  readonly tenantId: string;
  readonly dataClass: RetentionDataClass;
  readonly retentionDays: number;
  readonly minRetentionDays: number;
  readonly enabled: boolean;
  readonly legalHoldOverrides: boolean;
}

/**
 * Where an effective value came from. `tenant`: the tenant's stored value. `floor`: the tenant disabled
 * the class, so it runs at the platform floor. `platform_default`: no stored row for the class.
 */
export type RetentionSource = 'tenant' | 'floor' | 'platform_default';

export interface EffectiveRetention {
  readonly tenantId: string;
  readonly dataClass: RetentionDataClass;
  /** Whole UTC days from record creation after which a sweep may delete the record. */
  readonly retentionDays: number;
  readonly minRetentionDays: number;
  readonly source: RetentionSource;
  /** Always `false`: legal hold and Object Lock are checked before any deletion, never bypassed. */
  readonly legalHoldOverrides: false;
}

/**
 * The effective retention of one class for one tenant (RETAIN-001, used by the sweeps of RETAIN-002).
 *
 * - A missing row, or a row for another tenant, falls back to the platform default. It never means
 *   "keep forever".
 * - A row the tenant disabled runs at the platform floor.
 * - A stored value below the floor is raised to the floor (fail toward retaining less data than the
 *   row says is never allowed; the DB check constraint makes this unreachable in practice).
 * - An empty tenant id throws `TenantContextMissingError`: resolution fails closed.
 */
export function resolveRetention(
  policies: readonly RetentionPolicyRow[],
  tenantId: string,
  dataClass: RetentionDataClass,
): EffectiveRetention {
  if (tenantId.trim() === '') {
    throw new TenantContextMissingError('retention resolution requires a tenant id', {
      reason: 'missing',
    });
  }
  const defaults = RETENTION_DEFAULTS[dataClass];
  const row = policies.find((p) => p.tenantId === tenantId && p.dataClass === dataClass);
  if (row === undefined) {
    return {
      tenantId,
      dataClass,
      retentionDays: defaults.retentionDays,
      minRetentionDays: defaults.minRetentionDays,
      source: 'platform_default',
      legalHoldOverrides: false,
    };
  }
  const floor = Math.max(row.minRetentionDays, defaults.minRetentionDays);
  return {
    tenantId,
    dataClass,
    retentionDays: row.enabled ? Math.max(row.retentionDays, floor) : floor,
    minRetentionDays: floor,
    source: row.enabled ? 'tenant' : 'floor',
    legalHoldOverrides: false,
  };
}
