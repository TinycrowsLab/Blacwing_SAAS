import { describe, expect, it } from 'vitest';

import { SETTINGS_NAV_ENTRIES, visibleSettingsEntries } from './settings-nav';

const keysOf = (roles: readonly string[]) =>
  visibleSettingsEntries(roles).map((entry) => entry.key);

describe('visibleSettingsEntries', () => {
  it('lists every settings section for a tenant administrator', () => {
    expect(keysOf(['org_admin'])).toEqual(SETTINGS_NAV_ENTRIES.map((entry) => entry.key));
  });

  it('shows an auditor only the sections the auditor may read, and never the org profile', () => {
    const keys = keysOf(['auditor']);
    expect(keys).toContain('audit');
    expect(keys).not.toContain('org');
    expect(keys).not.toContain('safety');
  });

  it.each([
    ['a developer', ['developer']],
    ['an appsec engineer', ['appsec_engineer']],
    ['a CI pipeline', ['ci_pipeline']],
  ])('hides the organisation profile from %s', (_label, roles) => {
    expect(keysOf(roles)).not.toContain('org');
  });

  it('shows nothing with no roles, and ignores an unknown role', () => {
    expect(keysOf([])).toEqual([]);
    expect(keysOf(['platform_operator'])).toEqual([]);
  });

  it('gives every entry a route under /settings and a unique key', () => {
    const keys = SETTINGS_NAV_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SETTINGS_NAV_ENTRIES) {
      expect(entry.href.startsWith('/settings/')).toBe(true);
    }
  });
});
