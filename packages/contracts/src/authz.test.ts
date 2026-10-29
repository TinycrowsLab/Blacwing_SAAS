import { describe, expect, it } from 'vitest';

import {
  createStandingAuthorisationSchema,
  patchStandingAuthorisationSchema,
  SA_MAX_ASSETS,
} from './authz.js';

const ASSET = '0198f0a0-0000-7000-8000-0000000000e1';

const draft = {
  assetIds: [ASSET],
  scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
  maxIntrusiveness: 'active_safe',
  preApprovedTestClasses: ['header-audit'],
  defaultBudgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 3_600_000 },
  testWindows: [{ cron: '0 2 * * 1-5', timezone: 'Europe/Berlin', durationMs: 7_200_000 }],
  validFrom: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
};

describe('createStandingAuthorisationSchema', () => {
  it('accepts a complete draft', () => {
    expect(createStandingAuthorisationSchema.safeParse(draft).success).toBe(true);
  });

  it('refuses destructive as a ceiling (§8.3) and any unknown intrusiveness class', () => {
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, maxIntrusiveness: 'destructive' })
        .success,
    ).toBe(false);
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, maxIntrusiveness: 'nuke' }).success,
    ).toBe(false);
  });

  it('refuses unknown keys, so a smuggled tenant or owner field is never ignored', () => {
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, requesterId: ASSET }).success,
    ).toBe(false);
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, status: 'active' }).success,
    ).toBe(false);
  });

  it('requires at least one asset and at most the asset maximum', () => {
    expect(createStandingAuthorisationSchema.safeParse({ ...draft, assetIds: [] }).success).toBe(
      false,
    );
    expect(
      createStandingAuthorisationSchema.safeParse({
        ...draft,
        assetIds: new Array(SA_MAX_ASSETS + 1).fill(ASSET),
      }).success,
    ).toBe(false);
  });

  it('requires an include rule, a UUIDv7 asset and ISO-8601 UTC instants', () => {
    expect(
      createStandingAuthorisationSchema.safeParse({
        ...draft,
        scopeRules: { rules: [{ effect: 'exclude', host: 'x.example.test' }] },
      }).success,
    ).toBe(false);
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, assetIds: ['not-a-uuid'] }).success,
    ).toBe(false);
    expect(
      createStandingAuthorisationSchema.safeParse({ ...draft, validFrom: '2026-11-01' }).success,
    ).toBe(false);
  });
});

describe('patchStandingAuthorisationSchema', () => {
  it('accepts any subset of the draft fields', () => {
    expect(
      patchStandingAuthorisationSchema.safeParse({ maxIntrusiveness: 'passive' }).success,
    ).toBe(true);
  });

  it('refuses an empty patch, which would otherwise be a silent no-op', () => {
    expect(patchStandingAuthorisationSchema.safeParse({}).success).toBe(false);
  });

  it('still refuses unknown keys and destructive ceilings', () => {
    expect(
      patchStandingAuthorisationSchema.safeParse({ assetIds: [ASSET], owner: 'x' }).success,
    ).toBe(false);
    expect(
      patchStandingAuthorisationSchema.safeParse({ maxIntrusiveness: 'destructive' }).success,
    ).toBe(false);
  });
});
