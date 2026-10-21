import { describe, expect, it } from 'vitest';

import {
  ANALYST,
  CONFIRMED_VERDICT,
  FakePermissions,
  FakeSessions,
  FakeValidator,
  MemoryFindings,
  MemoryRunState,
  REF,
  REQUESTER,
  makeActivities,
  makeHarness,
} from './testing.js';

const FUTURE = '2026-06-01T00:00:00.000Z';

describe('validation routing', () => {
  it('enters validating, lists candidates and audits validation.started', async () => {
    const h = makeHarness({ findings: new MemoryFindings({ f1: 'candidate', f2: 'candidate' }) });
    const acts = makeActivities(h);
    const { candidateIds } = await acts.startValidation(REF);
    expect(candidateIds).toEqual(['f1', 'f2']);
    expect(h.runs.state).toBe('validating');
    expect(h.audit.actions()).toContain('validation.started');
  });

  it('routes confirmed and suspected, audits and counts each exactly once', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ ok: 'candidate', weak: 'candidate' }),
      validator: new FakeValidator({ weak: { ...CONFIRMED_VERDICT, oraclePassed: false } }),
    });
    const acts = makeActivities(h);
    for (const id of ['ok', 'weak']) {
      const outcome = await acts.validateCandidate({ ...REF, findingId: id });
      await acts.recordOutcome({ ...REF, outcome });
      await acts.recordOutcome({ ...REF, outcome }); // retry
    }
    expect(h.findings.status.get('ok')).toBe('confirmed');
    expect(h.findings.status.get('weak')).toBe('suspected');
    expect(h.metrics.candidates).toEqual(['confirmed', 'suspected']);
    expect(h.audit.actions().filter((a) => a === 'finding.confirmed')).toHaveLength(1);
    expect(h.audit.actions().filter((a) => a === 'finding.suspected')).toHaveLength(1);
    expect(h.findings.outcomes[0]).toMatchObject({
      evidenceBundleId: 'evb-1',
      reproArtifactId: 'repro-1',
    });
  });

  it('puts a confirmed verdict with a firing negative control in the suspected queue', async () => {
    const h = makeHarness({
      validator: new FakeValidator({ f: { ...CONFIRMED_VERDICT, negativeControlFired: true } }),
    });
    const outcome = await makeActivities(h).validateCandidate({ ...REF, findingId: 'f' });
    expect(outcome).toMatchObject({ outcome: 'suspected', reason: 'NEGATIVE_CONTROL_FIRED' });
  });

  it('lets a validator error surface so Temporal retries', async () => {
    const h = makeHarness({ validator: new FakeValidator({ f: new Error('sandbox gone') }) });
    await expect(makeActivities(h).validateCandidate({ ...REF, findingId: 'f' })).rejects.toThrow();
  });

  it('zero candidates: no work, still moves to awaiting_gate3 with nothing pending', async () => {
    const h = makeHarness();
    const acts = makeActivities(h);
    expect((await acts.startValidation(REF)).candidateIds).toEqual([]);
    expect(await acts.requestGate3(REF)).toEqual({ pending: 0 });
    expect(h.runs.state).toBe('awaiting_gate3');
  });

  it('a retried transition is a no-op and a lost race is retried', async () => {
    const h = makeHarness();
    const acts = makeActivities(h);
    await acts.startValidation(REF);
    await acts.startValidation(REF);
    expect(h.audit.actions().filter((a) => a === 'run.state_changed')).toHaveLength(1);
    h.runs.failNextSave = true;
    await expect(acts.requestGate3(REF)).rejects.toThrow();
    await acts.requestGate3(REF);
    expect(h.runs.state).toBe('awaiting_gate3');
  });
});

function atGate3(statuses: Record<string, 'confirmed' | 'suspected'>) {
  return makeHarness({
    findings: new MemoryFindings(statuses),
    runs: new MemoryRunState('awaiting_gate3'),
  });
}

describe('Gate 3', () => {
  it('releases a confirmed finding, records the releaser and moves the run to released', async () => {
    const h = atGate3({ f1: 'confirmed' });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'f1', decision: 'released' }] },
    });
    expect(v).toEqual({ accepted: true, allDecided: true, released: 1, refused: [] });
    expect(h.findings.decisions[0]).toMatchObject({
      findingId: 'f1',
      actorId: ANALYST,
      at: '2026-01-01T12:00:00.000Z',
    });
    expect(h.runs.state).toBe('released');
    expect(h.audit.actions()).toEqual(
      expect.arrayContaining(['gate3.decided', 'finding.released']),
    );
    expect(h.metrics.decisions).toEqual(['released']);
    expect(h.metrics.releasedCount).toBe(1);
  });

  it('blocks the requester (SoD) and changes nothing', async () => {
    // The requester holds the permission, so only SoD can stop them.
    const h = makeHarness({
      findings: new MemoryFindings({ f1: 'confirmed' }),
      runs: new MemoryRunState('awaiting_gate3'),
      permissions: new FakePermissions([REQUESTER]),
    });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: REQUESTER, decisions: [{ findingId: 'f1', decision: 'released' }] },
    });
    expect(v).toEqual({ accepted: false, code: 'GATE3_SOD_VIOLATION' });
    expect(h.findings.decisions).toHaveLength(0);
  });

  it('blocks everyone when the requester is unknown (fail closed)', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ f1: 'confirmed' }),
      runs: new MemoryRunState('awaiting_gate3', null),
    });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'f1', decision: 'released' }] },
    });
    expect(v).toEqual({ accepted: false, code: 'GATE3_SOD_VIOLATION' });
    expect(h.findings.status.get('f1')).toBe('confirmed');
  });

  it('blocks an actor without the Gate 3 permission', async () => {
    const h = atGate3({ f1: 'confirmed' });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: 'someone-else', decisions: [{ findingId: 'f1', decision: 'released' }] },
    });
    expect(v).toEqual({ accepted: false, code: 'GATE3_NOT_PERMITTED' });
    expect(h.findings.decisions).toHaveLength(0);
    expect(h.runs.state).toBe('awaiting_gate3');
    expect(h.audit.records.at(-1)).toMatchObject({ action: 'gate3.decided', outcome: 'failure' });
  });

  it('refuses a decision outside awaiting_gate3', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ f1: 'confirmed' }),
      runs: new MemoryRunState('validating'),
    });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'f1', decision: 'released' }] },
    });
    expect(v).toEqual({ accepted: false, code: 'GATE3_RUN_NOT_AWAITING' });
  });

  it('never releases a suspected finding, even when named (F17)', async () => {
    const h = atGate3({ good: 'confirmed', weak: 'suspected' });
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: {
        actorId: ANALYST,
        decisions: [
          { findingId: 'weak', decision: 'released' },
          { findingId: 'ghost', decision: 'released' },
        ],
      },
    });
    expect(v).toMatchObject({
      accepted: true,
      allDecided: false,
      refused: [
        { findingId: 'weak', code: 'FINDING_NOT_CONFIRMED' },
        { findingId: 'ghost', code: 'FINDING_NOT_FOUND' },
      ],
    });
    expect(h.findings.status.get('weak')).toBe('suspected');
    expect(h.runs.state).toBe('awaiting_gate3');
  });

  it('waits (not all decided) until every confirmed finding has a decision', async () => {
    const h = atGate3({ a: 'confirmed', b: 'confirmed', s: 'suspected' });
    const acts = makeActivities(h);
    const first = await acts.decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'a', decision: 'released' }] },
    });
    expect(first).toMatchObject({ accepted: true, allDecided: false });
    expect(h.runs.state).toBe('awaiting_gate3');
    const second = await acts.decideGate3({
      ...REF,
      signal: {
        actorId: ANALYST,
        decisions: [{ findingId: 'b', decision: 'rejected_false_positive' }],
      },
    });
    expect(second).toMatchObject({ allDecided: true, released: 0 });
    expect(h.runs.state).toBe('released');
  });

  it('accepted_risk needs a reason and a future expiry', async () => {
    const h = atGate3({ f: 'confirmed' });
    const acts = makeActivities(h);
    const bad = await acts.decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'f', decision: 'accepted_risk' }] },
    });
    expect(bad).toMatchObject({ refused: [{ code: 'ACCEPTED_RISK_NEEDS_REASON_AND_EXPIRY' }] });
    expect(h.findings.status.get('f')).toBe('confirmed');
    const ok = await acts.decideGate3({
      ...REF,
      signal: {
        actorId: ANALYST,
        decisions: [
          {
            findingId: 'f',
            decision: 'accepted_risk',
            reason: 'compensating control',
            expiresAt: FUTURE,
          },
        ],
      },
    });
    expect(ok).toMatchObject({ accepted: true, allDecided: true });
    expect(h.findings.decisions[0]).toMatchObject({
      reason: 'compensating control',
      expiresAt: FUTURE,
    });
    expect(
      h.audit.records.find((r) => r.metadata.decision === 'accepted_risk')?.metadata,
    ).toMatchObject({ expiresAt: FUTURE });
  });

  it('a duplicate release signal is idempotent', async () => {
    const h = atGate3({ f: 'confirmed', g: 'confirmed' });
    const acts = makeActivities(h);
    const signal = {
      actorId: ANALYST,
      decisions: [{ findingId: 'f', decision: 'released' as const }],
    };
    await acts.decideGate3({ ...REF, signal });
    const again = await acts.decideGate3({ ...REF, signal });
    expect(again).toMatchObject({ accepted: true, released: 0, refused: [] });
    expect(h.findings.decisions).toHaveLength(1);
    expect(h.metrics.releasedCount).toBe(1);
    expect(h.audit.actions().filter((a) => a === 'finding.released')).toHaveLength(1);
  });

  it('refuses to flip an already decided finding to another decision', async () => {
    const h = atGate3({ f: 'confirmed' });
    h.findings.status.set('f', 'rejected_false_positive');
    const v = await makeActivities(h).decideGate3({
      ...REF,
      signal: { actorId: ANALYST, decisions: [{ findingId: 'f', decision: 'released' }] },
    });
    expect(v).toMatchObject({ refused: [{ code: 'DECISION_CONFLICT' }] });
  });

  it('a timeout only pages and audits; it never releases', async () => {
    const h = atGate3({ f: 'confirmed' });
    await makeActivities(h).pageGate3Timeout({ ...REF, page: 1 });
    expect(h.pager.pages).toHaveLength(1);
    expect(h.findings.status.get('f')).toBe('confirmed');
    expect(h.runs.state).toBe('awaiting_gate3');
  });
});

describe('reporting', () => {
  function released() {
    return makeHarness({
      findings: new MemoryFindings({ a: 'released', b: 'rejected_false_positive', s: 'suspected' }),
      runs: new MemoryRunState('released'),
    });
  }

  it('hands only released findings to the reporter and remediation sessions', async () => {
    const h = released();
    const acts = makeActivities(h);
    await acts.startReporting(REF);
    await acts.runWriteUp({ ...REF, role: 'reporter' });
    await acts.runWriteUp({ ...REF, role: 'remediation' });
    expect(h.runs.state).toBe('reporting');
    expect(h.sessions.started).toEqual([
      { role: 'reporter', findingIds: ['a'] },
      { role: 'remediation', findingIds: ['a'] },
    ]);
    expect(h.audit.actions()).toContain('report.generated');
  });

  it('a failing session does not un-release a finding', async () => {
    const h = makeHarness({ ...released().deps, sessions: new FakeSessions('reporter') });
    await expect(makeActivities(h).runWriteUp({ ...REF, role: 'reporter' })).rejects.toThrow();
    expect(h.findings.status.get('a')).toBe('released');
  });

  it('refuses to complete without a finalised coverage manifest (F19)', async () => {
    const h = released();
    const acts = makeActivities(h);
    await acts.startReporting(REF);
    h.coverage.broken = true;
    await acts.finaliseCoverage(REF);
    expect(await acts.completeRun(REF)).toEqual({
      completed: false,
      code: 'COVERAGE_NOT_FINALISED',
    });
    expect(h.runs.state).toBe('reporting');
  });

  it('completes once the manifest is finalised, also with zero findings', async () => {
    const h = makeHarness({ runs: new MemoryRunState('reporting') });
    const acts = makeActivities(h);
    await acts.finaliseCoverage(REF);
    expect(await acts.completeRun(REF)).toEqual({ completed: true });
    expect(h.runs.state).toBe('completed');
  });

  it('aborts validation sandboxes on cleanup', async () => {
    const h = makeHarness();
    await makeActivities(h).abortValidation(REF);
    expect(h.validator.aborted).toEqual([REF.runId]);
  });
});
