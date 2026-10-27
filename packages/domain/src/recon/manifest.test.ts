import { describe, expect, it } from 'vitest';

import { INTRUSIVENESS_ORDER, type RunBudget, type RunMode } from '@blackwing/contracts';

import {
  RECON_BUDGET_SHARE,
  RECON_INTRUSIVENESS_CEILING,
  RECON_PERSONAS,
  resolveReconManifest,
} from './manifest.js';

const BUDGETS: RunBudget = { costCapUsd: 100, maxRequests: 10_000, maxDurationMs: 3_600_000 };
const personas = (mode: RunMode, supplied = true): string[] =>
  resolveReconManifest(mode, BUDGETS, { manifestSupplied: supplied }).entries.map((e) => e.persona);

describe('resolveReconManifest (CONTEXT_PACK §3.2 step 2)', () => {
  it('black box: passive-recon, osint, active-recon, threat-intel', () => {
    expect(personas('black')).toEqual(['passive-recon', 'osint', 'active-recon', 'threat-intel']);
  });

  it('grey box: active-recon, threat-intel, source-spec-ingestion, session-setup', () => {
    expect(personas('grey')).toEqual([
      'active-recon',
      'threat-intel',
      'source-spec-ingestion',
      'session-setup',
    ]);
  });

  it('white box: source-spec-ingestion, threat-intel, session-setup, minimal active-recon', () => {
    const { entries } = resolveReconManifest('white', BUDGETS);
    expect(entries.map((e) => e.persona)).toEqual([
      'source-spec-ingestion',
      'threat-intel',
      'session-setup',
      'active-recon',
    ]);
    expect(entries.filter((e) => e.minimal).map((e) => e.persona)).toEqual(['active-recon']);
  });

  it('only recon personas are ever dispatched and black box never starts a manifest persona', () => {
    for (const mode of ['black', 'grey', 'white'] as const) {
      for (const p of personas(mode)) expect(RECON_PERSONAS).toContain(p);
    }
    expect(personas('black')).not.toContain('source-spec-ingestion');
    expect(personas('grey')).not.toContain('osint');
    expect(personas('white')).not.toContain('passive-recon');
  });

  it('never dispatches above active_safe (recon may not be state_changing)', () => {
    for (const mode of ['black', 'grey', 'white'] as const) {
      for (const e of resolveReconManifest(mode, BUDGETS).entries) {
        expect(INTRUSIVENESS_ORDER[e.intrusiveness]).toBeLessThanOrEqual(
          INTRUSIVENESS_ORDER[RECON_INTRUSIVENESS_CEILING],
        );
      }
    }
    const active = resolveReconManifest('black', BUDGETS).entries.find(
      (e) => e.persona === 'active-recon',
    );
    expect(active?.intrusiveness).toBe('active_safe');
  });

  it('slices the run budget: cost and requests sum to the recon share, duration applies to each', () => {
    const m = resolveReconManifest('black', BUDGETS);
    expect(m.reconBudget).toEqual({
      costCapUsd: 100 * RECON_BUDGET_SHARE,
      maxRequests: 10_000 * RECON_BUDGET_SHARE,
      maxDurationMs: 3_600_000 * RECON_BUDGET_SHARE,
    });
    const cost = m.entries.reduce((s, e) => s + e.budget.costCapUsd, 0);
    const reqs = m.entries.reduce((s, e) => s + e.budget.maxRequests, 0);
    expect(cost).toBeLessThanOrEqual(m.reconBudget.costCapUsd + 1e-9);
    expect(reqs).toBeLessThanOrEqual(m.reconBudget.maxRequests);
    for (const e of m.entries) expect(e.budget.maxDurationMs).toBe(m.reconBudget.maxDurationMs);
  });

  it('gives the minimal active-recon a smaller slice than a full persona', () => {
    const { entries } = resolveReconManifest('white', BUDGETS);
    const minimal = entries.find((e) => e.minimal);
    const full = entries.find((e) => e.persona === 'threat-intel');
    expect(minimal?.budget.costCapUsd).toBeLessThan(full?.budget.costCapUsd ?? 0);
  });

  it('a tiny run budget still yields valid positive slices', () => {
    const m = resolveReconManifest('black', {
      costCapUsd: 0.001,
      maxRequests: 1,
      maxDurationMs: 1,
    });
    for (const e of m.entries) {
      expect(e.budget.costCapUsd).toBeGreaterThan(0);
      expect(e.budget.maxRequests).toBeGreaterThanOrEqual(1);
      expect(e.budget.maxDurationMs).toBeGreaterThanOrEqual(1);
    }
  });

  it('grey/white without a supplied manifest fall back to a full active-recon and warn', () => {
    const grey = resolveReconManifest('grey', BUDGETS, { manifestSupplied: false });
    expect(grey.warnings).toEqual(['RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON']);
    expect(grey.entries.find((e) => e.persona === 'active-recon')?.minimal).toBe(false);
    const white = resolveReconManifest('white', BUDGETS, { manifestSupplied: false });
    expect(white.entries.find((e) => e.persona === 'active-recon')?.minimal).toBe(false);
    expect(white.warnings).toHaveLength(1);
  });

  it('black box and supplied manifests produce no warning', () => {
    expect(resolveReconManifest('black', BUDGETS, { manifestSupplied: false }).warnings).toEqual(
      [],
    );
    expect(resolveReconManifest('grey', BUDGETS).warnings).toEqual([]);
  });

  it('fails closed on an unknown mode or an invalid budget', () => {
    expect(() => resolveReconManifest('purple' as RunMode, BUDGETS)).toThrow(/mode/);
    expect(() => resolveReconManifest('black', { ...BUDGETS, costCapUsd: 0 })).toThrow(/budgets/);
    expect(() => resolveReconManifest('black', { ...BUDGETS, maxRequests: Number.NaN })).toThrow();
    expect(() => resolveReconManifest('__proto__' as RunMode, BUDGETS)).toThrow(/mode/);
  });
});
