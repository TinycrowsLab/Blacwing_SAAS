import { describe, expect, it } from 'vitest';

import { GATE2_EXCEPTION_RAISED_SIGNAL as CONTRACT_RAISED } from '@blackwing/contracts';

import { createGate2ExceptionActivities } from './gate2-exception.js';
import {
  APPROVER,
  type MemoryGate2Exceptions,
  REF,
  REQUESTER,
  makeActivities,
  makeHarness,
} from './testing.js';
import { GATE2_EXCEPTION_RAISED_SIGNAL } from './types.js';

import type { Pager } from './ports.js';

const EX = '0190a000-0000-7000-8000-0000000000e1';
const PLAN_APPROVER = 'user-plan-approver';
const SYSTEM = { kind: 'system', id: 'gate2-timer' } as const;
const person = (id: string) => ({ kind: 'user', id }) as const;

function setup(dueInMs = 60_000, options: Parameters<MemoryGate2Exceptions['raise']>[2] = {}) {
  const h = makeHarness();
  h.gate2Exceptions.raise(EX, dueInMs, options);
  return { h, acts: makeActivities(h) };
}

describe('Gate 2 exception signal name', () => {
  it('matches the name the broker sends (GATE2-002)', () => {
    expect(GATE2_EXCEPTION_RAISED_SIGNAL).toBe(CONTRACT_RAISED);
  });
});

describe('readGate2Exception', () => {
  it('reads state, timeout_at and the store clock of an exception of the run', async () => {
    const { h, acts } = setup(60_000);
    const snap = await acts.readGate2Exception({ ...REF, exceptionId: EX });
    expect(snap).toMatchObject({ exceptionId: EX, state: 'pending' });
    expect(Date.parse(snap?.timeoutAt ?? '')).toBe(
      h.gate2Exceptions.rows.get(EX)?.timeoutAt.getTime(),
    );
  });

  it('reads an exception of another run as absent (run isolation)', async () => {
    const { acts } = setup();
    const other = { ...REF, runId: '0190a000-0000-7000-8000-0000000000b2' };
    expect(await acts.readGate2Exception({ ...other, exceptionId: EX })).toBeNull();
  });

  it('reads an unknown exception as absent', async () => {
    const { acts } = setup();
    expect(await acts.readGate2Exception({ ...REF, exceptionId: 'missing' })).toBeNull();
  });
});

describe('decideGate2Exception', () => {
  it('approves once when a different person decides before the deadline', async () => {
    const { h, acts } = setup();
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'the CDN is in the approved scope',
    });
    expect(verdict).toEqual({ kind: 'applied', state: 'approved_once' });
    expect(h.gate2Exceptions.state(EX)).toBe('approved_once');
    expect(h.metrics.gate2Decisions).toEqual(['approved']);
  });

  it('denies when a person denies', async () => {
    const { h, acts } = setup();
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'deny',
      actor: person(APPROVER),
      reason: 'out of scope',
    });
    expect(verdict).toEqual({ kind: 'applied', state: 'denied' });
    expect(h.metrics.gate2Decisions).toEqual(['denied']);
  });

  it('refuses an approval by the requester (separation of duties) and keeps the exception pending', async () => {
    const { h, acts } = setup();
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(REQUESTER),
      reason: 'self approval',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_SOD_VIOLATION' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
    expect(h.gate2Exceptions.applied).toEqual([]);
  });

  it('refuses an approval by the plan approver and keeps the exception pending', async () => {
    const { h, acts } = setup(60_000, { planApproverId: PLAN_APPROVER });
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(PLAN_APPROVER),
      reason: 'approved the plan too',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_SOD_VIOLATION' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });

  it('refuses a destructive exception even for an independent approver', async () => {
    const { h, acts } = setup(60_000, { intrusiveness: 'destructive' });
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'ok',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_DESTRUCTIVE_FORBIDDEN' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });

  it('refuses an approval without a reason and keeps the exception pending', async () => {
    const { h, acts } = setup();
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: '   ',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_ILLEGAL_TRANSITION' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });

  it('refuses an approval that arrives after the deadline (default deny)', async () => {
    const { h, acts } = setup(1000);
    h.gate2Exceptions.clock = () => new Date(Date.now() + 5000);
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'late',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_ILLEGAL_TRANSITION' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });

  it('records the timeout as a system denial once the deadline has passed', async () => {
    const { h, acts } = setup(1000);
    h.gate2Exceptions.clock = () => new Date(Date.now() + 5000);
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'time_out',
      actor: SYSTEM,
    });
    expect(verdict).toEqual({ kind: 'applied', state: 'timed_out' });
    expect(h.metrics.gate2Decisions).toEqual(['timeout']);
  });

  it('throws when the timeout is recorded before the deadline, so the timer and the store cannot disagree silently', async () => {
    const { h, acts } = setup(60_000);
    await expect(
      acts.decideGate2Exception({ ...REF, exceptionId: EX, event: 'time_out', actor: SYSTEM }),
    ).rejects.toThrow('gate 2 timeout refused');
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });

  it('lets the first committed decision win: a late timeout after an approval changes nothing', async () => {
    const { h, acts } = setup();
    await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'ok',
    });
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'time_out',
      actor: SYSTEM,
    });
    expect(verdict).toEqual({ kind: 'lost', state: 'approved_once' });
    expect(h.gate2Exceptions.state(EX)).toBe('approved_once');
  });

  it('refuses a second person decision on an exception already decided (duplicate signal)', async () => {
    const { h, acts } = setup();
    await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'ok',
    });
    const verdict = await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'deny',
      actor: person('user-other-approver'),
      reason: 'changed my mind',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_ALREADY_DECIDED' });
    expect(h.gate2Exceptions.state(EX)).toBe('approved_once');
    expect(h.gate2Exceptions.applied).toHaveLength(1);
  });

  it('refuses a decision on an exception of another run without touching it', async () => {
    const { h, acts } = setup();
    const other = { ...REF, runId: '0190a000-0000-7000-8000-0000000000b2' };
    const verdict = await acts.decideGate2Exception({
      ...other,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'wrong run',
    });
    expect(verdict).toEqual({ kind: 'refused', code: 'GATE2_NOT_FOUND' });
    expect(h.gate2Exceptions.state(EX)).toBe('pending');
  });
});

describe('pageGate2Escalation', () => {
  it('pages the run once per level and counts the escalation', async () => {
    const { h, acts } = setup();
    await acts.pageGate2Escalation({ ...REF, exceptionId: EX, level: 1 });
    expect(h.pager.pages).toHaveLength(1);
    expect(h.pager.pages[0]).toContain(EX);
    expect(h.pager.pages[0]).toContain('level 1');
    expect(h.metrics.escalations).toEqual([1]);
  });

  it('propagates a paging failure so Temporal retries the activity', async () => {
    const { h } = setup();
    const failing: Pager = { page: () => Promise.reject(new Error('pager down')) };
    const acts = createGate2ExceptionActivities({
      exceptions: h.gate2Exceptions,
      pager: failing,
      metrics: h.metrics,
    });
    await expect(acts.pageGate2Escalation({ ...REF, exceptionId: EX, level: 0 })).rejects.toThrow(
      'pager down',
    );
    expect(h.metrics.escalations).toEqual([]);
  });
});

describe('supersedeGate2Exceptions', () => {
  it('denies every pending exception of the run by superseding it', async () => {
    const { h, acts } = setup();
    h.gate2Exceptions.raise('0190a000-0000-7000-8000-0000000000e2', 60_000);
    await acts.supersedeGate2Exceptions(REF);
    expect(h.gate2Exceptions.state(EX)).toBe('superseded');
    expect(h.gate2Exceptions.state('0190a000-0000-7000-8000-0000000000e2')).toBe('superseded');
    expect(h.metrics.gate2Decisions).toEqual(['denied', 'denied']);
  });

  it('leaves exceptions of other runs and already decided exceptions alone, and is idempotent', async () => {
    const { h, acts } = setup();
    const otherRun = '0190a000-0000-7000-8000-0000000000b2';
    h.gate2Exceptions.raise('other', 60_000, { runId: otherRun });
    await acts.decideGate2Exception({
      ...REF,
      exceptionId: EX,
      event: 'approve',
      actor: person(APPROVER),
      reason: 'ok',
    });
    await acts.supersedeGate2Exceptions(REF);
    await acts.supersedeGate2Exceptions(REF);
    expect(h.gate2Exceptions.state(EX)).toBe('approved_once');
    expect(h.gate2Exceptions.state('other')).toBe('pending');
  });
});

describe('the store wiring', () => {
  it('exposes the four exception activities on the execution activities', () => {
    const acts = makeActivities(makeHarness());
    expect(typeof acts.readGate2Exception).toBe('function');
    expect(typeof acts.decideGate2Exception).toBe('function');
    expect(typeof acts.pageGate2Escalation).toBe('function');
    expect(typeof acts.supersedeGate2Exceptions).toBe('function');
  });
});
