// Preflight catalogue (#579): the id list, the read-only (dry-run) classing and the remediation text.

import { describe, expect, it } from 'vitest';

import {
  dryRunDefinitions,
  isPreflightCheckId,
  PREFLIGHT_CATALOGUE,
  PREFLIGHT_CHECK_IDS,
  PREFLIGHT_SEVERITIES,
} from './catalogue.js';

describe('preflight catalogue', () => {
  it('lists the check ids in the canonical ORCH-003 order', () => {
    expect(PREFLIGHT_CATALOGUE.map((definition) => definition.id)).toEqual([
      'verifyAuthorisation',
      'resolveAndScopeTargets',
      'verifyAssetsVerified',
      'loginPerRole',
      'assertLockoutExemption',
      'assertWindowOpen',
      'deliverSocNotice',
      'assertBudgetsAvailable',
      'assertModelProviderReachable',
    ]);
    expect(PREFLIGHT_CATALOGUE.map((definition) => definition.id)).toEqual([
      ...PREFLIGHT_CHECK_IDS,
    ]);
  });

  it('gives every check a unique id, a known severity and a non-empty title and remediation', () => {
    const ids = PREFLIGHT_CATALOGUE.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of PREFLIGHT_CATALOGUE) {
      expect(PREFLIGHT_SEVERITIES).toContain(definition.severity);
      expect(definition.title.trim()).not.toBe('');
      expect(definition.remediation.trim()).not.toBe('');
    }
  });

  it('is frozen so a consumer cannot mutate the shared definitions', () => {
    expect(Object.isFrozen(PREFLIGHT_CATALOGUE)).toBe(true);
  });

  it('marks exactly the read-only checks as dry-run safe', () => {
    expect(dryRunDefinitions().map((definition) => definition.id)).toEqual([
      'verifyAuthorisation',
      'resolveAndScopeTargets',
      'verifyAssetsVerified',
      'assertLockoutExemption',
      'assertWindowOpen',
      'assertBudgetsAvailable',
      'assertModelProviderReachable',
    ]);
  });

  it('never marks a login or a SOC notice as dry-run safe (no side effects in a dry run)', () => {
    const byId = new Map(PREFLIGHT_CATALOGUE.map((definition) => [definition.id, definition]));
    expect(byId.get('loginPerRole')?.dryRun).toBe(false);
    expect(byId.get('deliverSocNotice')?.dryRun).toBe(false);
  });

  it('narrows an untrusted string to a known check id only', () => {
    expect(isPreflightCheckId('assertWindowOpen')).toBe(true);
    expect(isPreflightCheckId('test_window_open')).toBe(false);
    expect(isPreflightCheckId('__proto__')).toBe(false);
    expect(isPreflightCheckId('constructor')).toBe(false);
    expect(isPreflightCheckId(undefined)).toBe(false);
    expect(isPreflightCheckId(42)).toBe(false);
  });
});
