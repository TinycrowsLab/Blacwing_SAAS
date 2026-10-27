import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { parseOnly, SEED_STEP_NAMES, selectSeeders } from './seeders.js';

const NO_PROBLEMS: ReadonlyMap<string, readonly string[]> = new Map();

const ALL_TENANT_STEPS = [
  'memberships',
  'assets',
  'credentials',
  'standing-authorisations',
  'role-matrices',
];

describe('parseOnly', () => {
  it('returns undefined when --only is absent, so every step runs', () => {
    expect(parseOnly(undefined)).toBeUndefined();
  });

  it('accepts a comma list of step names, trimmed and de-duplicated', () => {
    expect(parseOnly(' assets, credentials ,assets')).toEqual(['assets', 'credentials']);
  });

  it('accepts the platform step name', () => {
    expect(parseOnly('tenant')).toEqual(['tenant']);
  });

  it('refuses an empty list, including a bare --only with no value', () => {
    expect(() => parseOnly('')).toThrow(ValidationError);
    expect(() => parseOnly(' , ')).toThrow(/at least one step name/);
  });

  it('refuses an unknown name before anything is written, and lists the valid names', () => {
    expect(() => parseOnly('assets,bogus')).toThrow(/unknown --only step\(s\): bogus/);
    expect(() => parseOnly('assets,bogus')).toThrow(SEED_STEP_NAMES.join(', '));
  });
});

describe('selectSeeders', () => {
  it('runs every tenant-scoped step in order when nothing is missing and --only is absent', () => {
    expect(selectSeeders({ only: undefined, problems: NO_PROBLEMS })).toEqual({
      run: ALL_TENANT_STEPS,
      skipped: [],
    });
  });

  it('runs only the named steps under --only, and does not report the left-out ones as skipped', () => {
    expect(selectSeeders({ only: ['role-matrices'], problems: NO_PROBLEMS })).toEqual({
      run: ['role-matrices'],
      skipped: [],
    });
  });

  it('runs a selected step whose dependency is left out but whose tables exist', () => {
    expect(selectSeeders({ only: ['credentials'], problems: NO_PROBLEMS })).toEqual({
      run: ['credentials'],
      skipped: [],
    });
  });

  it('skips a step whose table is not migrated, with the reason, and cascades to its dependents', () => {
    const problems = new Map([['assets', ['table assets does not exist']]]);
    expect(selectSeeders({ only: undefined, problems })).toEqual({
      run: ['memberships'],
      skipped: [
        { name: 'assets', reason: 'table assets does not exist' },
        { name: 'credentials', reason: 'depends on skipped step assets' },
        { name: 'standing-authorisations', reason: 'depends on skipped step assets' },
        { name: 'role-matrices', reason: 'depends on skipped step assets' },
      ],
    });
  });

  it('skips a step whose column has the wrong type, and names the column', () => {
    const problems = new Map([
      ['asset_credentials', ['column asset_credentials.secret_ref is int4, expected text']],
    ]);
    expect(selectSeeders({ only: undefined, problems }).skipped).toEqual([
      {
        name: 'credentials',
        reason: 'column asset_credentials.secret_ref is int4, expected text',
      },
    ]);
  });

  it('skips a selected dependent when its dependency is unavailable even though --only left the dependency out', () => {
    const problems = new Map([['assets', ['table assets does not exist']]]);
    expect(selectSeeders({ only: ['credentials'], problems })).toEqual({
      run: [],
      skipped: [{ name: 'credentials', reason: 'depends on skipped step assets' }],
    });
  });
});
