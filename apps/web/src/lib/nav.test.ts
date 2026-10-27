import { describe, expect, it } from 'vitest';

import { ROLES } from '@blackwing/contracts';

import { isActive, NAV_ITEMS, visibleNav } from './nav';

const keys = (roles: readonly string[]): string[] =>
  visibleNav(roles).flatMap((group) => group.items.map((item) => item.key));

describe('visibleNav', () => {
  it('shows a developer no admin items and no members/settings/audit', () => {
    const seen = keys(['developer']);
    expect(seen).toEqual(expect.arrayContaining(['runs', 'assets', 'findings']));
    expect(seen).not.toContain('members');
    expect(seen).not.toContain('settings');
    expect(seen).not.toContain('audit');
  });

  it('shows an auditor the audit log but never write-gated sections', () => {
    const seen = keys(['auditor']);
    expect(seen).toContain('audit');
    expect(seen).not.toContain('members');
    expect(seen).not.toContain('settings');
  });

  it('shows an org admin the Admin section', () => {
    expect(keys(['org_admin'])).toEqual(expect.arrayContaining(['members', 'settings', 'audit']));
  });

  it.each([[[]], [['nonsense']], [['platform_operator']]])(
    'renders only ungated items for unknown or empty roles %j',
    (roles) => {
      expect(keys(roles)).toEqual(
        NAV_ITEMS.filter((i) => i.requiredPermission === undefined).map((i) => i.key),
      );
    },
  );

  it('never lists an empty section and keeps keys unique', () => {
    for (const role of ROLES) {
      for (const group of visibleNav([role])) expect(group.items.length).toBeGreaterThan(0);
    }
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
  });
});

describe('isActive', () => {
  it('matches the route and nested routes but not siblings with a shared prefix', () => {
    expect(isActive('/runs', '/runs')).toBe(true);
    expect(isActive('/runs/run_abc123', '/runs')).toBe(true);
    expect(isActive('/runsx', '/runs')).toBe(false);
    expect(isActive('/runs', '/')).toBe(false);
    expect(isActive('/', '/')).toBe(true);
  });
});
