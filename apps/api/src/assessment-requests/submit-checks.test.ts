import { describe, expect, it } from 'vitest';

import {
  ASSET_UNVERIFIED_A,
  ASSET_VERIFIED_A,
  activeSaA,
  GRANTED_RULE,
  NOW,
} from './fixtures.test-helpers.js';
import { checkSubmission, type SubmitCheckInput } from './submit-checks.js';

import type { AssetFact, StandingAuthorisationFact } from './ports.js';

const verified: AssetFact[] = [{ id: ASSET_VERIFIED_A, verificationStatus: 'verified' }];
const request = (overrides: Partial<SubmitCheckInput> = {}): SubmitCheckInput => ({
  assetIds: [ASSET_VERIFIED_A],
  saId: 'sa',
  maxIntrusiveness: 'active_safe',
  scopeRules: { rules: [GRANTED_RULE] },
  budgets: { costCapUsd: 5, maxRequests: 5000, maxDurationMs: 3600000 },
  ...overrides,
});
const codes = (failures: ReturnType<typeof checkSubmission>) => failures.map((f) => f.code);
const sa = (overrides: Partial<StandingAuthorisationFact> = {}): StandingAuthorisationFact => ({
  ...activeSaA(),
  ...overrides,
});

describe('checkSubmission (SCOPE-005 submit gate)', () => {
  it('passes a verified, in-scope, in-budget request under an active SA', () => {
    expect(checkSubmission(request(), verified, sa(), NOW)).toEqual([]);
  });

  it('reports NO_ASSETS for an empty asset list', () => {
    expect(codes(checkSubmission(request({ assetIds: [] }), [], sa(), NOW))).toEqual(['NO_ASSETS']);
  });

  it('reports SA_REQUIRED and stops the SA-bound checks when no SA is visible', () => {
    expect(codes(checkSubmission(request(), verified, undefined, NOW))).toEqual(['SA_REQUIRED']);
  });

  it('treats an SA whose expiry is exactly now as expired (the window is closed)', () => {
    expect(codes(checkSubmission(request(), verified, sa({ expiresAt: NOW }), NOW))).toContain(
      'SA_EXPIRED',
    );
  });

  it('reports SA_EXPIRED for an SA marked expired, even with a future expiry', () => {
    expect(codes(checkSubmission(request(), verified, sa({ status: 'expired' }), NOW))).toEqual([
      'SA_EXPIRED',
    ]);
  });

  it('reports SA_NOT_ACTIVE for a pending or revoked SA', () => {
    expect(
      codes(checkSubmission(request(), verified, sa({ status: 'pending_approval' }), NOW)),
    ).toEqual(['SA_NOT_ACTIVE']);
    expect(codes(checkSubmission(request(), verified, sa({ status: 'revoked' }), NOW))).toEqual([
      'SA_NOT_ACTIVE',
    ]);
  });

  it('reports ASSET_NOT_VERIFIED for a pending or unverified asset, addressed by index', () => {
    const failures = checkSubmission(
      request({ assetIds: [ASSET_VERIFIED_A, ASSET_UNVERIFIED_A] }),
      [...verified, { id: ASSET_UNVERIFIED_A, verificationStatus: 'pending' }],
      sa(),
      NOW,
    );
    expect(failures).toEqual([
      expect.objectContaining({ code: 'ASSET_NOT_VERIFIED', path: 'assetIds[1]' }),
    ]);
  });

  it('reports SA_SCOPE_MISMATCH for an asset the SA does not cover', () => {
    const failures = checkSubmission(
      request(),
      verified,
      sa({ assetIds: ['0198f0a0-0000-7000-8000-00000000ffff'] }),
      NOW,
    );
    expect(codes(failures)).toContain('SA_SCOPE_MISMATCH');
  });

  it('reports INTRUSIVENESS_NOT_AUTHORISED for state_changing under a lower SA ceiling', () => {
    expect(
      codes(checkSubmission(request({ maxIntrusiveness: 'state_changing' }), verified, sa(), NOW)),
    ).toEqual(['INTRUSIVENESS_NOT_AUTHORISED']);
  });

  it('allows state_changing when the SA ceiling permits it', () => {
    expect(
      checkSubmission(
        request({ maxIntrusiveness: 'state_changing' }),
        verified,
        sa({ maxIntrusiveness: 'state_changing' }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('reports INTRUSIVENESS_EXCEEDS_SA for passive requests against a stricter SA', () => {
    expect(
      codes(
        checkSubmission(
          request({ maxIntrusiveness: 'active_safe' }),
          verified,
          sa({ maxIntrusiveness: 'passive' }),
          NOW,
        ),
      ),
    ).toEqual(['INTRUSIVENESS_EXCEEDS_SA']);
  });

  it('matches scope rules by canonical JSON, so key order does not matter', () => {
    const reordered = { host: 'app.example.test', effect: 'include' };
    expect(
      checkSubmission(request({ scopeRules: { rules: [reordered] } }), verified, sa(), NOW),
    ).toEqual([]);
  });

  it('reports SCOPE_EXCEEDS_SA for a rule the SA does not grant (never widening)', () => {
    const failures = checkSubmission(
      request({
        scopeRules: { rules: [GRANTED_RULE, { effect: 'include', host: 'other.example.test' }] },
      }),
      verified,
      sa(),
      NOW,
    );
    expect(failures).toEqual([
      expect.objectContaining({ code: 'SCOPE_EXCEEDS_SA', path: 'scopeRules.rules[1]' }),
    ]);
  });

  it('reports BUDGET_EXCEEDS_SA for a budget above the SA default on any dimension', () => {
    expect(
      codes(checkSubmission(request({ budgets: { costCapUsd: 11 } }), verified, sa(), NOW)),
    ).toEqual(['BUDGET_EXCEEDS_SA']);
  });

  it('returns every failing check together, not the first one', () => {
    const failures = checkSubmission(
      request({
        assetIds: [ASSET_UNVERIFIED_A],
        maxIntrusiveness: 'state_changing',
        scopeRules: { rules: [{ effect: 'include', host: 'x.example.test' }] },
        budgets: { costCapUsd: 99 },
      }),
      [{ id: ASSET_UNVERIFIED_A, verificationStatus: 'unverified' }],
      sa({ maxIntrusiveness: 'active_safe' }),
      NOW,
    );
    expect(codes(failures).sort()).toEqual(
      [
        'ASSET_NOT_VERIFIED',
        'BUDGET_EXCEEDS_SA',
        'INTRUSIVENESS_NOT_AUTHORISED',
        'SCOPE_EXCEEDS_SA',
      ].sort(),
    );
  });
});
