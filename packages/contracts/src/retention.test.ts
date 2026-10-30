import { describe, expect, it } from 'vitest';

import {
  RETENTION_DATA_CLASSES,
  RETENTION_DEFAULTS,
  retentionPolicyUpdateSchema,
  retentionPolicySchema,
} from './retention.js';

const item = (dataClass: string, retentionDays: number, enabled = true): unknown => ({
  dataClass,
  retentionDays,
  enabled,
});

describe('RETENTION_DEFAULTS', () => {
  it('seeds the platform defaults from the Context Pack issue', () => {
    expect(RETENTION_DEFAULTS).toEqual({
      findings: { retentionDays: 730, minRetentionDays: 90 },
      evidence: { retentionDays: 365, minRetentionDays: 30 },
      logs: { retentionDays: 90, minRetentionDays: 30 },
      transcripts: { retentionDays: 180, minRetentionDays: 30 },
      reports: { retentionDays: 730, minRetentionDays: 90 },
      oob_interactions: { retentionDays: 30, minRetentionDays: 7 },
    });
  });

  it('has a default at or above its floor for every class', () => {
    for (const dataClass of RETENTION_DATA_CLASSES) {
      const { retentionDays, minRetentionDays } = RETENTION_DEFAULTS[dataClass];
      expect(retentionDays).toBeGreaterThanOrEqual(minRetentionDays);
    }
  });
});

describe('retentionPolicyUpdateSchema', () => {
  it('accepts a valid partial update', () => {
    const parsed = retentionPolicyUpdateSchema.safeParse({
      policies: [item('evidence', 60), item('logs', 30, false)],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a value below the platform floor (edge: never below floor)', () => {
    const parsed = retentionPolicyUpdateSchema.safeParse({ policies: [item('evidence', 29)] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/platform floor/);
  });

  it('accepts exactly the floor and rejects one day less', () => {
    expect(
      retentionPolicyUpdateSchema.safeParse({ policies: [item('evidence', 30)] }).success,
    ).toBe(true);
    expect(
      retentionPolicyUpdateSchema.safeParse({ policies: [item('evidence', 29)] }).success,
    ).toBe(false);
  });

  it('disables only down to the floor: a disabled class must set the floor exactly', () => {
    expect(
      retentionPolicyUpdateSchema.safeParse({ policies: [item('findings', 90, false)] }).success,
    ).toBe(true);
    expect(
      retentionPolicyUpdateSchema.safeParse({ policies: [item('findings', 365, false)] }).success,
    ).toBe(false);
  });

  it('rejects a data class listed twice', () => {
    const parsed = retentionPolicyUpdateSchema.safeParse({
      policies: [item('logs', 60), item('logs', 45)],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('each data class may appear once');
  });

  it('rejects an unknown data class, a zero or fractional day count and an empty list', () => {
    expect(retentionPolicyUpdateSchema.safeParse({ policies: [item('secrets', 60)] }).success).toBe(
      false,
    );
    expect(retentionPolicyUpdateSchema.safeParse({ policies: [item('logs', 0)] }).success).toBe(
      false,
    );
    expect(retentionPolicyUpdateSchema.safeParse({ policies: [item('logs', 45.5)] }).success).toBe(
      false,
    );
    expect(retentionPolicyUpdateSchema.safeParse({ policies: [] }).success).toBe(false);
  });

  it('rejects more days than the ten-year cap', () => {
    expect(
      retentionPolicyUpdateSchema.safeParse({ policies: [item('reports', 3651)] }).success,
    ).toBe(false);
  });

  it('refuses legal_hold_overrides and any other unknown key (no way to override legal hold)', () => {
    const withHold = {
      policies: [{ ...(item('evidence', 60) as object), legalHoldOverrides: true }],
    };
    expect(retentionPolicyUpdateSchema.safeParse(withHold).success).toBe(false);
    expect(
      retentionPolicyUpdateSchema.safeParse({
        policies: [item('evidence', 60)],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('retentionPolicySchema', () => {
  const view = {
    dataClass: 'logs',
    retentionDays: 90,
    minRetentionDays: 30,
    enabled: true,
    legalHoldOverrides: false,
    updatedAt: null,
  };

  it('pins legalHoldOverrides to false', () => {
    expect(retentionPolicySchema.safeParse(view).success).toBe(true);
    expect(retentionPolicySchema.safeParse({ ...view, legalHoldOverrides: true }).success).toBe(
      false,
    );
  });

  it('requires ISO-8601 UTC timestamps for updatedAt', () => {
    expect(
      retentionPolicySchema.safeParse({ ...view, updatedAt: '2026-10-28T10:00:00.000Z' }).success,
    ).toBe(true);
    expect(
      retentionPolicySchema.safeParse({ ...view, updatedAt: '2026-10-28 10:00' }).success,
    ).toBe(false);
  });
});
