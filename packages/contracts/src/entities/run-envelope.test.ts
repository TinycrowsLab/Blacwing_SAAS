import { describe, expect, it } from 'vitest';

import { runEnvelopeSchema, type RunEnvelope } from '../index.js';

const TENANT = '0190a5d0-1111-7111-8111-111111111111';
const SA = '0190a5d0-3333-7333-8333-333333333333';
const A = '0190a5d0-4444-7444-8444-444444444444';
const B = '0190a5d0-5555-7555-8555-555555555555';

function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run_01jbz3k6w8f5r4t2n9q7x0m1ab',
    tenantId: TENANT,
    assetIds: [A, B],
    scopeRules: { rules: [{ effect: 'include', host: 'app.lab.test' }] },
    testWindows: [{ cron: '0 * * * *', timezone: 'UTC', durationMs: 3_600_000 }],
    maxIntrusiveness: 'active_safe',
    approvedTestCaseIds: ['tc-a', 'tc-b'],
    budgets: { costCapUsd: 10, maxRequests: 1000, maxDurationMs: 3_600_000 },
    saId: SA,
    saExpiresAt: '2026-10-29T18:00:00.000Z',
    runWindowEndsAt: null,
    approvedPlanVersion: 2,
    approverId: 'user-approver',
    approvedAt: '2026-10-29T10:00:00.000Z',
    envelopeVersion: 1,
    ...over,
  };
}

const parses = (value: unknown) => runEnvelopeSchema.safeParse(value).success;

describe('runEnvelopeSchema', () => {
  it('accepts a complete envelope', () => {
    expect(parses(valid())).toBe(true);
    const parsed: RunEnvelope = runEnvelopeSchema.parse(valid());
    expect(parsed.envelopeVersion).toBe(1);
  });

  it('refuses an unknown field (strict: nothing unsigned rides along)', () => {
    expect(parses(valid({ extra: true }))).toBe(false);
  });

  it('refuses a destructive intrusiveness class, which no authorisation can grant (§8.3)', () => {
    expect(parses(valid({ maxIntrusiveness: 'destructive' }))).toBe(false);
  });

  it('refuses unsorted or duplicate asset ids and test case ids (one canonical body per run)', () => {
    expect(parses(valid({ assetIds: [B, A] }))).toBe(false);
    expect(parses(valid({ assetIds: [A, A] }))).toBe(false);
    expect(parses(valid({ approvedTestCaseIds: ['tc-b', 'tc-a'] }))).toBe(false);
  });

  it('refuses a scope with no include rule (default deny)', () => {
    expect(parses(valid({ scopeRules: { rules: [] } }))).toBe(false);
  });

  it('refuses an envelope with no assets or no approved test cases', () => {
    expect(parses(valid({ assetIds: [] }))).toBe(false);
    expect(parses(valid({ approvedTestCaseIds: [] }))).toBe(false);
  });

  it('refuses a non-positive envelope version and a non-UTC instant', () => {
    expect(parses(valid({ envelopeVersion: 0 }))).toBe(false);
    expect(parses(valid({ envelopeVersion: 1.5 }))).toBe(false);
    expect(parses(valid({ approvedAt: '2026-10-29T10:00:00+01:00' }))).toBe(false);
  });

  it('requires the SA expiry and allows the run window to be absent', () => {
    expect(parses(valid({ saExpiresAt: undefined }))).toBe(false);
    expect(parses(valid({ runWindowEndsAt: '2026-10-29T12:00:00.000Z' }))).toBe(true);
  });

  it('refuses a run id outside the public run id format', () => {
    expect(parses(valid({ runId: 'not-a-run' }))).toBe(false);
  });
});
