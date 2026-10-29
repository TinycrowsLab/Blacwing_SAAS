import { describe, expect, it } from 'vitest';

import { standingAuthorisationSchema, type StandingAuthorisation } from './authorisation.js';
import { projectSaEnvelope, SA_ENVELOPE_VERSION, saEnvelopeSchema } from './sa-envelope.js';

const ID = (n: number): string => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';

const sa = {
  id: ID(4),
  tenantId: ID(1),
  assetIds: [ID(9), ID(3)],
  scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
  maxIntrusiveness: 'active_safe',
  preApprovedTestClasses: ['header-audit', 'cookie-flags'],
  defaultBudgets: { costCapUsd: 25, maxRequests: 1000, maxDurationMs: 3_600_000 },
  testWindows: [{ cron: '0 9 * * 1-5', timezone: 'Europe/London', durationMs: 28_800_000 }],
  validFrom: T0,
  expiresAt: T2,
  requesterId: ID(2),
  approverId: ID(5),
  signature: 'eyJhbGciOiJFZERTQSJ9..sig',
  signingKeyId: 'key-1',
  status: 'active',
  revocationReason: null,
  createdAt: T0,
  updatedAt: T0,
} as const satisfies Record<string, unknown>;

/** The SA as the schema parses it, so the projection test starts from a valid row. */
const row = (): StandingAuthorisation => standingAuthorisationSchema.parse(structuredClone(sa));

describe('SA envelope (#375)', () => {
  it('projects exactly the signed subset of the SA', () => {
    const envelope = projectSaEnvelope(row());
    expect(Object.keys(envelope).sort()).toEqual(
      [
        'approverId',
        'assetIds',
        'defaultBudgets',
        'expiresAt',
        'maxIntrusiveness',
        'preApprovedTestClasses',
        'requesterId',
        'saId',
        'scopeRules',
        'tenantId',
        'testWindows',
        'validFrom',
        'version',
      ].sort(),
    );
    expect(envelope.saId).toBe(ID(4));
    expect(envelope.version).toBe(SA_ENVELOPE_VERSION);
  });

  it('sorts identifier and test-class lists so producers agree on one body', () => {
    const envelope = projectSaEnvelope(row());
    expect(envelope.assetIds).toEqual([ID(3), ID(9)]);
    expect(envelope.preApprovedTestClasses).toEqual(['cookie-flags', 'header-audit']);
  });

  it('keeps a null approver before approval instead of dropping the key', () => {
    const envelope = projectSaEnvelope({ ...row(), approverId: null });
    expect(envelope).toHaveProperty('approverId', null);
  });

  it('rejects unsorted or duplicated lists, unknown keys and status or signature fields', () => {
    const envelope = projectSaEnvelope(row());
    expect(saEnvelopeSchema.safeParse({ ...envelope, assetIds: [ID(9), ID(3)] }).success).toBe(
      false,
    );
    expect(saEnvelopeSchema.safeParse({ ...envelope, assetIds: [ID(3), ID(3)] }).success).toBe(
      false,
    );
    expect(
      saEnvelopeSchema.safeParse({
        ...envelope,
        preApprovedTestClasses: ['b', 'a'],
      }).success,
    ).toBe(false);
    expect(saEnvelopeSchema.safeParse({ ...envelope, status: 'active' }).success).toBe(false);
    expect(saEnvelopeSchema.safeParse({ ...envelope, signature: 'x' }).success).toBe(false);
  });

  it('never carries the destructive class (§8.3)', () => {
    const envelope = projectSaEnvelope(row());
    expect(
      saEnvelopeSchema.safeParse({ ...envelope, maxIntrusiveness: 'destructive' }).success,
    ).toBe(false);
  });

  it('rejects a version other than the one this layout defines', () => {
    const envelope = projectSaEnvelope(row());
    expect(saEnvelopeSchema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
  });
});
