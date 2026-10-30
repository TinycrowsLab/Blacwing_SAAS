import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { observationWith } from './fixtures.js';
import { OOB_AUDIT_EVENT, oobEvaluator, OOB_REASONS } from './out-of-band.js';

import type { SignalStore } from './signals.js';
import type { OobHit } from '@blackwing/oob';

const REPLAY_ID = '0190a000-0000-7000-8000-000000000001';
const TOKEN = 'a1b2c3d4e5';
const OTHER_TENANT_TOKEN = 'z9y8x7w6v5';
const params = { channel: 'dns', windowMs: 30_000 } as const;

function evaluate(
  interactions: readonly OobHit[] | undefined,
  options: { token?: string; p?: unknown } = {},
) {
  const store: SignalStore = (id) =>
    id !== REPLAY_ID || interactions === undefined
      ? undefined
      : { oob: { token: options.token ?? TOKEN, interactions } };
  return oobEvaluator(store)(observationWith([], REPLAY_ID), options.p ?? params);
}

const dnsHit = (offsetMs: number, token = TOKEN): OobHit => ({
  token,
  channel: 'dns',
  offsetMs,
});

describe('oob evaluator', () => {
  it('fires on a correlated interaction on the per-test token inside the window', () => {
    expect(evaluate([dnsHit(1_500)])).toEqual({
      matched: true,
      reason: OOB_REASONS.correlated,
      auditEvent: OOB_AUDIT_EVENT,
    });
  });

  it('carries no audit event when the callback does not correlate', () => {
    expect(evaluate([dnsHit(1_500, OTHER_TENANT_TOKEN)]).auditEvent).toBeUndefined();
  });

  it('does not fire on an uncorrelated interaction carrying another token (cross-tenant token)', () => {
    expect(evaluate([dnsHit(1_500, OTHER_TENANT_TOKEN)])).toEqual({
      matched: false,
      reason: OOB_REASONS.noCorrelatedInteraction,
    });
  });

  it('does not count a late interaction after the window', () => {
    expect(evaluate([dnsHit(30_001)])).toEqual({
      matched: false,
      reason: OOB_REASONS.noCorrelatedInteraction,
    });
  });

  it('is not fired when no interaction arrived at all (Suspected, not Confirmed)', () => {
    expect(evaluate([])).toEqual({ matched: false, reason: OOB_REASONS.noCorrelatedInteraction });
  });

  it('does not fire on the wrong channel', () => {
    expect(evaluate([{ token: TOKEN, channel: 'http', offsetMs: 100 }])).toEqual({
      matched: false,
      reason: OOB_REASONS.noCorrelatedInteraction,
    });
  });

  it('is Suspected when no OOB signal was recorded for the replay', () => {
    expect(evaluate(undefined)).toEqual({ matched: false, reason: OOB_REASONS.noOobSignal });
  });

  it('refuses malformed params and a window beyond the correlation limit', () => {
    expect(() => evaluate([], { p: { channel: 'ftp', windowMs: 1 } })).toThrow(ValidationError);
    expect(() => evaluate([], { p: { channel: 'dns', windowMs: 300_001 } })).toThrow(
      ValidationError,
    );
    expect(() => evaluate([], { p: { channel: 'dns', windowMs: 0 } })).toThrow(ValidationError);
  });
});
