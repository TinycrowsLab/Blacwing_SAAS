import { describe, expect, it } from 'vitest';

import { intrusivenessAllowed, scopeAllows } from './scope-check.js';

const rules = {
  rules: [
    { effect: 'include', host: 'app.example.test' },
    { effect: 'exclude', host: 'admin.app.example.test' },
  ],
};

describe('scopeAllows', () => {
  it('allows a target the SCOPE matcher places in scope', () => {
    expect(scopeAllows({ scopeRules: rules }, { host: 'app.example.test', port: 443 })).toBe(true);
  });

  it('is default-deny for a target outside every include rule', () => {
    expect(scopeAllows({ scopeRules: rules }, { host: 'other.example.test' })).toBe(false);
  });

  it('lets a more specific exclude carve a host out of an include (the matcher decides)', () => {
    expect(scopeAllows({ scopeRules: rules }, { host: 'admin.app.example.test' })).toBe(false);
  });

  it('denies every target when the stored rules cannot be parsed (fail closed)', () => {
    for (const scopeRules of [null, 'rules', { rules: [{ effect: 'include', host: '' }] }, {}]) {
      expect(scopeAllows({ scopeRules }, { host: 'app.example.test' })).toBe(false);
    }
  });

  it('denies an empty target and an empty rule set', () => {
    expect(scopeAllows({ scopeRules: rules }, {})).toBe(false);
    expect(scopeAllows({ scopeRules: { rules: [] } }, { host: 'app.example.test' })).toBe(false);
  });
});

describe('intrusivenessAllowed', () => {
  const sa = { maxIntrusiveness: 'active_safe' as const };

  it('allows a class at or below the ceiling', () => {
    expect(intrusivenessAllowed(sa, 'passive')).toBe(true);
    expect(intrusivenessAllowed(sa, 'active_safe')).toBe(true);
  });

  it('refuses a class above the ceiling', () => {
    expect(intrusivenessAllowed(sa, 'state_changing')).toBe(false);
  });

  it('never allows destructive, even against a ceiling that names it (§8.3)', () => {
    expect(intrusivenessAllowed(sa, 'destructive')).toBe(false);
    expect(intrusivenessAllowed({ maxIntrusiveness: 'state_changing' }, 'destructive')).toBe(false);
  });
});
