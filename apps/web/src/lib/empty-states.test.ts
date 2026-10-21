import { describe, expect, it } from 'vitest';

import { EMPTY_STATE_KINDS, emptyStateFor, permissionsForRoles } from './empty-states';

const ALL = permissionsForRoles([
  'org_admin',
  'appsec_engineer',
  'asset_owner',
  'developer',
  'auditor',
  'ci_pipeline',
]);

describe('emptyStateFor', () => {
  it.each(EMPTY_STATE_KINDS)('%s has copy and a non-empty hint', (kind) => {
    const state = emptyStateFor(kind, new Set());
    expect(state.title.length).toBeGreaterThan(0);
    expect(state.description.length).toBeGreaterThan(20);
    expect(state.hint).not.toBeNull();
  });

  it('offers the next step when the viewer holds the permission', () => {
    expect(emptyStateFor('assets', permissionsForRoles(['appsec_engineer'])).action).toEqual({
      label: 'Add asset',
      href: '/assets/new',
    });
    expect(
      emptyStateFor('standing-authorisations', permissionsForRoles(['asset_owner'])).action,
    ).toEqual({
      label: 'Create standing authorisation',
      href: '/authorisations/new',
    });
    expect(emptyStateFor('runs', permissionsForRoles(['developer'])).action).toEqual({
      label: 'Request assessment',
      href: '/assessments/new',
    });
    expect(emptyStateFor('findings', permissionsForRoles(['auditor'])).action).toEqual({
      label: 'View assessments',
      href: '/assessments',
    });
  });

  it('never offers an action the viewer cannot take, and explains instead', () => {
    // Developer: may request runs but not register assets or create standing authorisations.
    const developer = permissionsForRoles(['developer']);
    const assets = emptyStateFor('assets', developer);
    expect(assets.action).toBeNull();
    expect(assets.hint).toMatch(/teammate/);
    expect(emptyStateFor('standing-authorisations', developer).action).toBeNull();
    expect(emptyStateFor('runs', developer).action).not.toBeNull();
  });

  it('keeps the auditor read-only: no empty state offers a create action', () => {
    const auditor = permissionsForRoles(['auditor']);
    for (const kind of EMPTY_STATE_KINDS) {
      const state = emptyStateFor(kind, auditor);
      expect(state.action?.href ?? '').not.toMatch(/new$/);
    }
    expect(emptyStateFor('assets', auditor).action).toBeNull();
    expect(emptyStateFor('runs', auditor).action).toBeNull();
  });

  it('shows no CTA and a hint when the viewer has no permissions at all', () => {
    for (const kind of EMPTY_STATE_KINDS) {
      const state = emptyStateFor(kind, new Set());
      expect(state.action).toBeNull();
      expect(state.hint).not.toBeNull();
    }
  });

  it('gives the org admin no run or approval CTA (separation of duties)', () => {
    const admin = permissionsForRoles(['org_admin']);
    expect(emptyStateFor('runs', admin).action).toBeNull();
    expect(emptyStateFor('standing-authorisations', admin).action).toBeNull();
  });

  it('keeps every CTA href a fixed console route', () => {
    for (const kind of EMPTY_STATE_KINDS) {
      const { action } = emptyStateFor(kind, ALL);
      expect(action?.href).toMatch(/^\/[a-z/-]+$/);
    }
  });
});

describe('permissionsForRoles', () => {
  it('unions the grants of several roles', () => {
    const set = permissionsForRoles(['developer', 'auditor']);
    expect(set.has('run:create')).toBe(true);
    expect(set.has('audit:read')).toBe(true);
    expect(set.has('asset:write')).toBe(false);
  });

  it('grants nothing for an unknown role or none', () => {
    expect(permissionsForRoles([]).size).toBe(0);
    expect(permissionsForRoles(['platform_operator' as never]).size).toBe(0);
    expect(permissionsForRoles(['__proto__' as never]).size).toBe(0);
  });
});
