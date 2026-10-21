import { describe, expect, it } from 'vitest';

import { permissionsForRoles } from './empty-states';
import { firstRunChecklist } from './first-run-checklist';

const NONE_DONE = { verifiedAssetCount: 0, activeAuthorisationCount: 0, requestedRunCount: 0 };
const ALL_DONE = { verifiedAssetCount: 2, activeAuthorisationCount: 1, requestedRunCount: 5 };
const APPSEC = permissionsForRoles(['appsec_engineer']);

describe('firstRunChecklist', () => {
  it('lists the three steps in order, none done for a new tenant', () => {
    const model = firstRunChecklist(NONE_DONE, APPSEC);
    expect(model.steps.map((s) => s.id)).toEqual(['verify-asset', 'create-sa', 'request-run']);
    expect(model.steps.every((s) => !s.done)).toBe(true);
    expect(model.visible).toBe(true);
    expect(model.complete).toBe(false);
  });

  it('marks each step done from its own tenant fact', () => {
    const model = firstRunChecklist(
      { verifiedAssetCount: 1, activeAuthorisationCount: 0, requestedRunCount: 0 },
      APPSEC,
    );
    expect(model.steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(model.visible).toBe(true);
  });

  it('tracks completion as the tenant data changes', () => {
    const before = firstRunChecklist(NONE_DONE, APPSEC);
    const after = firstRunChecklist({ ...NONE_DONE, verifiedAssetCount: 1 }, APPSEC);
    expect(before.steps[0]?.done).toBe(false);
    expect(after.steps[0]?.done).toBe(true);
  });

  it('is hidden and complete once every step is done (existing tenant)', () => {
    const model = firstRunChecklist(ALL_DONE, APPSEC);
    expect(model.complete).toBe(true);
    expect(model.visible).toBe(false);
  });

  it('counts a run request alone as a done step, not as the whole checklist', () => {
    const model = firstRunChecklist(
      { verifiedAssetCount: 0, activeAuthorisationCount: 0, requestedRunCount: 3 },
      APPSEC,
    );
    expect(model.steps.map((s) => s.done)).toEqual([false, false, true]);
    expect(model.complete).toBe(false);
    expect(model.visible).toBe(true);
  });

  it('links steps the viewer can act on and explains the ones they cannot', () => {
    const developer = firstRunChecklist(NONE_DONE, permissionsForRoles(['developer']));
    const [verify, sa, run] = developer.steps;
    expect(verify?.href).toBeUndefined();
    expect(verify?.disabledReason).toMatch(/Ask a teammate/);
    expect(sa?.href).toBeUndefined();
    expect(run?.href).toBe('/assessments/new');
    expect(run?.disabledReason).toBeUndefined();
  });

  it('does not explain a step the viewer cannot act on once it is done', () => {
    const developer = firstRunChecklist(
      { ...NONE_DONE, verifiedAssetCount: 1 },
      permissionsForRoles(['developer']),
    );
    expect(developer.steps[0]?.done).toBe(true);
    expect(developer.steps[0]?.disabledReason).toBeUndefined();
  });

  it('is never shown to a viewer who cannot act on any step (auditor)', () => {
    const model = firstRunChecklist(NONE_DONE, permissionsForRoles(['auditor']));
    expect(model.visible).toBe(false);
    expect(model.steps.length).toBe(3);
  });

  it('is hidden for a viewer with no permissions at all', () => {
    expect(firstRunChecklist(NONE_DONE, new Set()).visible).toBe(false);
  });

  it.each([
    ['negative count', { ...NONE_DONE, verifiedAssetCount: -1 }],
    ['fractional count', { ...NONE_DONE, requestedRunCount: 1.5 }],
    ['string count', { ...NONE_DONE, activeAuthorisationCount: '2' }],
    ['missing field', { verifiedAssetCount: 1, activeAuthorisationCount: 1 }],
    ['unexpected field', { ...NONE_DONE, tenantId: 'acme' }],
    ['null facts', null],
  ])('fails closed on malformed facts (%s)', (_label, facts) => {
    const model = firstRunChecklist(facts, APPSEC);
    expect(model.visible).toBe(false);
    expect(model.steps).toEqual([]);
  });
});
