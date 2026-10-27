import { describe, expect, it } from 'vitest';

import { INTRUSIVENESS_ORDER } from '@blackwing/contracts';

import { createReconActivities } from './activities.js';
import { allFailed } from './orchestrate.js';
import {
  CancelledError,
  FakeSurface,
  MemoryRunRepo,
  REF,
  makeFacts,
  makeHarness,
  type Harness,
} from './testing.js';

const dispatchedPersonas = (h: Harness): string[] => h.dispatched.map((d) => d.persona).sort();
const actions = (h: Harness): string[] => h.audit.records.map((r) => r.action);

describe('recon phase: manifest dispatch (acceptance 1-3)', () => {
  it('black box starts exactly passive-recon, osint, active-recon, threat-intel', async () => {
    const h = makeHarness();
    const d = await h.run();
    expect(dispatchedPersonas(h)).toEqual([
      'active-recon',
      'osint',
      'passive-recon',
      'threat-intel',
    ]);
    expect(d.event).toBe('recon_complete');
    expect(d.statusReason).toBeNull();
  });

  it('grey box starts active-recon, threat-intel, source-spec-ingestion, session-setup', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'grey', manifestSuppliesSurface: true })),
    });
    await h.run();
    expect(dispatchedPersonas(h)).toEqual([
      'active-recon',
      'session-setup',
      'source-spec-ingestion',
      'threat-intel',
    ]);
  });

  it('white box starts source-spec-ingestion, threat-intel, session-setup and a minimal active-recon', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'white', manifestSuppliesSurface: true })),
    });
    await h.run();
    expect(dispatchedPersonas(h)).toEqual([
      'active-recon',
      'session-setup',
      'source-spec-ingestion',
      'threat-intel',
    ]);
    expect(h.dispatched.find((d) => d.persona === 'active-recon')?.minimal).toBe(true);
  });

  it('dispatches every child with the tenant, run, recon phase, a unique session and a budget slice', async () => {
    const h = makeHarness();
    await h.run();
    expect(new Set(h.dispatched.map((d) => d.sessionId)).size).toBe(4);
    for (const d of h.dispatched) {
      expect(d.tenantId).toBe(REF.tenantId);
      expect(d.runId).toBe(REF.runId);
      expect(d.phase).toBe('recon');
      expect(d.budget.costCapUsd).toBeGreaterThan(0);
      expect(d.budget.costCapUsd).toBeLessThanOrEqual(100 * 0.2);
    }
  });

  it('runs the children with intrusiveness at most active_safe (acceptance 5)', async () => {
    for (const mode of ['black', 'grey', 'white'] as const) {
      const h = makeHarness({
        repo: new MemoryRunRepo(makeFacts({ mode, manifestSuppliesSurface: true })),
      });
      await h.run();
      for (const d of h.dispatched) {
        expect(INTRUSIVENESS_ORDER[d.intrusiveness]).toBeLessThanOrEqual(
          INTRUSIVENESS_ORDER.active_safe,
        );
      }
    }
  });

  it('grey box with no manifest falls back to a full active-recon, still runs, and logs a warning', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'white', manifestSuppliesSurface: false })),
    });
    const d = await h.run();
    expect(d.event).toBe('recon_complete');
    expect(h.dispatched.find((x) => x.persona === 'active-recon')?.minimal).toBe(false);
    const started = h.audit.records.find((r) => r.action === 'recon.started');
    expect(started?.metadata.warnings).toBe('RECON_MANIFEST_MISSING_FELL_BACK_TO_ACTIVE_RECON');
  });
});

describe('recon phase: failures (acceptance 4, 6)', () => {
  it('one crashing persona is recorded and the phase still completes', async () => {
    const h = makeHarness();
    const d = await h.run({ osint: { kind: 'crash' } });
    expect(d.event).toBe('recon_complete');
    expect(d.sessions.find((s) => s.persona === 'osint')?.outcome).toBe('failed');
    expect(d.sessions.filter((s) => s.outcome === 'completed')).toHaveLength(3);
    const finished = h.audit.records.filter((r) => r.action === 'recon.session.finished');
    expect(finished.find((r) => r.metadata.persona === 'osint')?.outcome).toBe('failure');
  });

  it('all personas crashing fails the run with RECON_ALL_SESSIONS_FAILED', async () => {
    const h = makeHarness();
    const crash = { kind: 'crash' } as const;
    const d = await h.run({
      'passive-recon': crash,
      osint: crash,
      'active-recon': crash,
      'threat-intel': crash,
    });
    expect(d).toMatchObject({
      event: 'fail',
      statusReason: 'recon_failed:RECON_ALL_SESSIONS_FAILED',
    });
    expect(h.surface.reads).toBe(0);
    expect(actions(h).at(-1)).toBe('recon.completed');
    expect(h.audit.records.at(-1)?.outcome).toBe('failure');
  });

  it('a persona that ran out of budget or was declined does not fail the phase', async () => {
    const h = makeHarness();
    const d = await h.run({
      osint: { kind: 'ok', status: 'error_max_budget_usd', costUsd: 0.1 },
      'passive-recon': { kind: 'ok', status: 'model_declined', costUsd: 0 },
    });
    expect(d.event).toBe('recon_complete');
    expect(d.sessions.map((s) => s.outcome)).toContain('error_max_budget_usd');
    expect(d.sessions.map((s) => s.outcome)).toContain('model_declined');
  });

  it('an empty surface in black box fails with RECON_EMPTY_SURFACE', async () => {
    const h = makeHarness({ surface: new FakeSurface({ hosts: 0, endpoints: 0 }) });
    const d = await h.run();
    expect(d).toMatchObject({ event: 'fail', statusReason: 'recon_failed:RECON_EMPTY_SURFACE' });
    expect(actions(h).at(-1)).toBe('recon.completed');
  });

  it('a grey/white run whose manifest supplied the surface passes with an empty store', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'grey', manifestSuppliesSurface: true })),
      surface: new FakeSurface({ hosts: 0, endpoints: 0 }),
    });
    expect((await h.run()).event).toBe('recon_complete');
  });

  it('a grey run without a supplied manifest still fails on an empty surface', async () => {
    const h = makeHarness({
      repo: new MemoryRunRepo(makeFacts({ mode: 'grey', manifestSuppliesSurface: false })),
      surface: new FakeSurface({ hosts: 0, endpoints: 0 }),
    });
    expect((await h.run()).statusReason).toBe('recon_failed:RECON_EMPTY_SURFACE');
  });

  it('a host alone, or an endpoint alone, is enough surface', async () => {
    for (const counts of [
      { hosts: 1, endpoints: 0 },
      { hosts: 0, endpoints: 1 },
    ]) {
      const h = makeHarness({ surface: new FakeSurface(counts) });
      expect((await h.run()).event).toBe('recon_complete');
    }
  });

  it('retries a failed surface read instead of deciding on a guess', async () => {
    const surface = new FakeSurface();
    surface.failures = 2;
    const h = makeHarness({ surface });
    expect((await h.run()).event).toBe('recon_complete');
    expect(surface.reads).toBe(3);
  });

  it('a surface read that keeps failing surfaces the error and never completes the phase', async () => {
    const surface = new FakeSurface();
    surface.failures = 99;
    const h = makeHarness({ surface });
    await expect(h.run()).rejects.toThrow('surface store unavailable');
    expect(actions(h)).not.toContain('recon.completed');
  });

  it('refuses a run that does not exist for the tenant or is not in recon, dispatching nothing', async () => {
    const missing = makeHarness({ repo: new MemoryRunRepo(null) });
    expect((await missing.run()).statusReason).toBe('recon_failed:RUN_NOT_FOUND');
    const wrongState = makeHarness({ repo: new MemoryRunRepo(makeFacts({ state: 'planning' })) });
    expect((await wrongState.run()).statusReason).toBe('recon_failed:RUN_NOT_IN_RECON');
    expect(missing.dispatched).toHaveLength(0);
    expect(wrongState.dispatched).toHaveLength(0);
    expect(wrongState.audit.records).toHaveLength(0);
  });

  it("does not see another tenant's run (tenant isolation)", async () => {
    const h = makeHarness();
    const acts = createReconActivities(h.deps);
    const result = await acts.startRecon({ tenantId: 'other-tenant', runId: REF.runId });
    expect(result).toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  });
});

describe('recon phase: cost cap (requirement 5)', () => {
  it('stops the remaining children once cumulative spend reaches the recon budget', async () => {
    const h = makeHarness();
    const d = await h.run({
      'passive-recon': { kind: 'ok', costUsd: 25 },
      osint: { kind: 'hang' },
      'active-recon': { kind: 'hang' },
      'threat-intel': { kind: 'hang' },
    });
    expect(d.sessions.map((s) => s.outcome)).toEqual([
      'completed',
      'cost_cap',
      'cost_cap',
      'cost_cap',
    ]);
    expect(d.costUsd).toBe(25);
    // Not a failure: the surface check decides.
    expect(d.event).toBe('recon_complete');
  });

  it('does not cancel anything when spend stays under the budget', async () => {
    const h = makeHarness();
    const d = await h.run();
    expect(d.sessions.every((s) => s.outcome === 'completed')).toBe(true);
    expect(d.costUsd).toBeCloseTo(0.4);
  });

  it('ignores a non-finite or negative reported cost', async () => {
    const h = makeHarness();
    const d = await h.run({
      osint: { kind: 'ok', costUsd: Number.NaN },
      'passive-recon': { kind: 'ok', costUsd: -5 },
    });
    expect(Number.isFinite(d.costUsd)).toBe(true);
    expect(d.sessions.every((s) => s.outcome === 'completed')).toBe(true);
  });
});

describe('recon phase: cancellation (kill, SA expiry)', () => {
  it('cancels every child, audits the abort and rethrows the cancellation', async () => {
    const h = makeHarness();
    const hang = { kind: 'hang' } as const;
    const running = h.run({
      'passive-recon': hang,
      osint: hang,
      'active-recon': hang,
      'threat-intel': hang,
    });
    const settled = running.then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 10));
    h.kill();
    expect(await settled).toBeInstanceOf(CancelledError);
    const finished = h.audit.records.filter((r) => r.action === 'recon.session.finished');
    expect(finished).toHaveLength(4);
    expect(finished.every((r) => r.metadata.status === 'cancelled')).toBe(true);
    const last = h.audit.records.at(-1);
    expect(last?.action).toBe('recon.completed');
    expect(last?.metadata.result).toBe('cancelled');
    expect(h.surface.reads).toBe(0);
  });
});

describe('recon phase: audit and metrics', () => {
  it('emits recon.started, a session pair per persona and recon.completed in order', async () => {
    const h = makeHarness();
    await h.run();
    const seq = actions(h);
    expect(seq[0]).toBe('recon.started');
    expect(seq.at(-1)).toBe('recon.completed');
    expect(seq.filter((a) => a === 'recon.session.started')).toHaveLength(4);
    expect(seq.filter((a) => a === 'recon.session.finished')).toHaveLength(4);
    expect(h.audit.records.at(-1)).toMatchObject({ outcome: 'success', ...REF });
    for (const r of h.audit.records) expect(r.tenantId).toBe(REF.tenantId);
  });

  it('uses stable dedupe keys so a retried activity cannot append a duplicate', async () => {
    const h = makeHarness();
    await h.run();
    const keys = h.audit.records.map((r) => r.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    const acts = createReconActivities(h.deps);
    await acts.recordSessionStarted({ ...REF, persona: 'osint', sessionId: 's' });
    const again = h.audit.records.filter(
      (r) => r.action === 'recon.session.started' && r.metadata.persona === 'osint',
    );
    expect(new Set(again.map((r) => r.dedupeKey)).size).toBe(1);
  });

  it('counts sessions by persona, mode and status and records the phase duration', async () => {
    const h = makeHarness();
    await h.run({ osint: { kind: 'crash' } });
    expect(h.metrics.sessions).toContainEqual(['osint', 'black', 'failed']);
    expect(h.metrics.sessions).toContainEqual(['threat-intel', 'black', 'completed']);
    expect(h.metrics.durations).toEqual([1.5]);
  });

  it('never puts surface data or secrets in audit metadata', async () => {
    const h = makeHarness();
    await h.run();
    const text = JSON.stringify(h.audit.records);
    expect(text).not.toMatch(/password|secret|token|credential/i);
  });
});

describe('allFailed', () => {
  const rec = (outcome: 'failed' | 'error' | 'completed' | 'cost_cap') => ({
    persona: 'osint' as const,
    sessionId: 's',
    outcome,
    costUsd: 0,
  });
  it('is true only when there is at least one session and all crashed or errored', () => {
    expect(allFailed([])).toBe(false);
    expect(allFailed([rec('failed'), rec('error')])).toBe(true);
    expect(allFailed([rec('failed'), rec('completed')])).toBe(false);
    expect(allFailed([rec('failed'), rec('cost_cap')])).toBe(false);
  });
});
