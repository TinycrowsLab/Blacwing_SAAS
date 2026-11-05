import { describe, expect, it } from 'vitest';

import { oracleWords, proofSentence, requestLine } from './issue-body';
import {
  actionLabel,
  decisions,
  duration,
  findingDetailSchema,
  gate2Outcome,
  splitFindings,
  stopLine,
  testCases,
} from './model';

const ev = (seq: number, kind: string, data: Record<string, unknown> = {}, at = `2026-11-06T10:${String(seq).padStart(2, '0')}:00.000Z`) => ({
  seq,
  kind,
  stage: 'x',
  message: '',
  data,
  at,
});
const finding = (id: string, severity: string, status: string, createdAt = '2026-11-06T10:00:00.000Z') => ({
  id,
  title: `T-${id}`,
  severity,
  status,
  assetName: null,
  agent: null,
  cwe: null,
  owasp: null,
  createdAt,
});
const gate2 = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  runId: 'r1',
  agent: 'authz-specialist',
  method: 'post',
  url: 'http://127.0.0.1:3001/rest/basket/7/checkout?x=1',
  pathKey: '',
  intrusiveness: 'state_changing',
  reason: '',
  whyOutside: '',
  status,
  deadlineAt: '2026-11-06T10:20:00.000Z',
  createdAt: '2026-11-06T10:15:00.000Z',
  decidedBy: null,
  decidedAt: null,
  secondsLeft: 0,
  decisionReason: null,
  ...extra,
});

describe('splitFindings', () => {
  it('proves what the validator confirmed, sorted by severity, and keeps the rest back', () => {
    const run = {
      events: [ev(1, 'finding.confirmed', { findingId: 'a' }), ev(2, 'finding.confirmed', { findingId: 'c' })],
      findings: [finding('a', 'low', 'released'), finding('b', 'high', 'suspected'), finding('c', 'critical', 'confirmed'), finding('d', 'medium', 'confirmed')],
    };
    const { proven, kept } = splitFindings(run);
    expect(proven.map((f) => f.id)).toEqual(['c', 'd', 'a']);
    expect(kept.map((f) => f.id)).toEqual(['b']);
  });
});

describe('testCases', () => {
  it('takes the plan total and counts cases whose latest status is executed', () => {
    const events = [
      ev(1, 'plan.cases', { cases: [{ id: 'x' }, { id: 'y' }], total: 2 }),
      ev(2, 'plan.cases', { cases: [{ id: 'z' }], total: 3 }),
      ev(3, 'case.status', { caseId: 'x', status: 'executing' }),
      ev(4, 'case.status', { caseId: 'x', status: 'executed' }),
      ev(5, 'case.status', { caseId: 'y', status: 'skipped' }),
    ];
    expect(testCases(events)).toEqual({ executed: 1, total: 3 });
    expect(testCases([])).toEqual({ executed: 0, total: 0 });
  });
});

describe('duration and stopLine', () => {
  it('formats durations', () => {
    expect(duration(45_000)).toBe('45s');
    expect(duration(1_092_000)).toBe('18m 12s');
    expect(duration(3_720_000)).toBe('1h 02m');
  });
  it('says why the run stopped, in words', () => {
    const base = { createdAt: '2026-11-06T10:00:00.000Z', startedAt: '2026-11-06T10:00:00.000Z', finishedAt: '2026-11-06T10:18:12.000Z' };
    expect(stopLine({ ...base, state: 'completed', events: [ev(1, 'run.completed', { reason: 'duration_budget' })] }, 0)).toEqual({
      tone: 'ok',
      text: 'Finished in 18m 12s · stopped at the time limit',
    });
    expect(stopLine({ ...base, state: 'completed', events: [ev(1, 'run.completed')] }, 0).text).toContain('finished its plan');
    expect(stopLine({ ...base, state: 'killed', events: [] }, 0).text).toBe('Stopped after 18m 12s · you stopped testing');
    expect(stopLine({ ...base, state: 'failed', events: [ev(1, 'run.failed', { reason: 'model_error' })] }, 0).tone).toBe('bad');
  });
});

describe('gate2Outcome', () => {
  it('summarises the decisions asked', () => {
    expect(gate2Outcome([])).toEqual({ asked: 0, label: 'none' });
    expect(gate2Outcome([gate2('a', 'denied'), gate2('b', 'expired')])).toEqual({ asked: 2, label: 'both denied' });
    expect(gate2Outcome([gate2('a', 'approved')])).toEqual({ asked: 1, label: 'allowed' });
    expect(gate2Outcome([gate2('a', 'approved'), gate2('b', 'denied'), gate2('c', 'denied')]).label).toBe('1 allowed, 2 denied');
  });
});

describe('decisions', () => {
  it('lists Gate 1, Gate 2 (with expiry and role), Gate 3 from the ledger and automatic releases, oldest first', () => {
    const run = {
      id: 'r1',
      events: [
        ev(1, 'gate2.requested', { gate2Id: 'g1', asRole: 'customer_a' }),
        ev(30, 'finding.released', { findingId: 'f2', auto: true }),
      ],
      findings: [finding('f1', 'low', 'released'), finding('f2', 'high', 'released')],
      gate2: [
        gate2('g1', 'denied', { decidedBy: 'Jatin Singh', decidedAt: '2026-11-06T10:17:00.000Z' }),
        gate2('g2', 'expired'),
        gate2('g3', 'pending'),
      ],
    };
    const rows = decisions({
      run,
      request: { id: 'q1', status: 'approved', approver: { id: 'u', name: 'Jatin Singh' }, decisionReason: 'Our own lab.', decidedAt: '2026-11-06T10:02:00.000Z' },
      ledger: [
        {
          eventId: 'e1',
          seq: 9,
          at: '2026-11-06T10:41:00.000Z',
          actor: { id: 'u2', name: 'Riley Reviewer' },
          action: 'finding.release',
          targetType: 'finding',
          targetId: 'f1',
          payload: { runId: 'r1', reason: 'Low risk, fix tracked.' },
          hash: 'h',
        },
        { eventId: 'e2', seq: 10, at: '2026-11-06T10:42:00.000Z', actor: { id: 'u', name: 'X' }, action: 'finding.release', targetType: 'finding', targetId: 'zz', payload: { runId: 'other' }, hash: 'h' },
      ],
      viewerName: 'Jatin Singh',
      gate2TimeoutS: 300,
    });
    expect(rows.map((r) => [r.group, r.verb, r.subject?.text ?? null, r.detail, r.reason, r.who])).toEqual([
      ['Approval', 'Approved the plan', null, null, 'Our own lab.', null],
      ['Request', 'Denied', 'POST /rest/basket/7/checkout?x=1', 'as customer_a', null, null],
      ['Request', 'Denied automatically', 'POST /rest/basket/7/checkout?x=1', 'no answer in 5 min', null, null],
      ['Release', 'Released automatically', 'T-f2', 'as you chose on the plan', null, null],
      ['Release', 'Released', 'T-f1', null, 'Low risk, fix tracked.', 'Riley Reviewer'],
    ]);
  });
});

describe('issue proof copy', () => {
  const detail = findingDetailSchema.parse({
    id: 'f',
    title: 't',
    oracle: { type: 'body_contains', value: 'http_requests_count' },
    evidence: {
      probe: { request: { method: 'get', url: 'http://h:1/metrics?a=1' }, response: { status: 200 } },
      control: {},
      replays: [
        { n: 1, status: 200, matched: true },
        { n: 2, status: 200, matched: true },
        { n: 3, status: 200, matched: true },
      ],
    },
    replay: { control: { status: 200, matched: false } },
  });
  it('states the replay count and the control from stored evidence', () => {
    expect(proofSentence(detail)).toEqual({
      proven: true,
      text: 'Proven: replayed 3 of 3 times, the control behaved as expected. No model involved.',
    });
    expect(requestLine(detail.evidence.probe)).toBe('GET /metrics?a=1');
    expect(requestLine(detail.evidence.control)).toBeNull();
    expect(oracleWords(detail.oracle)).toBe('the response contains “http_requests_count”');
  });
  it('says why an issue was not proven', () => {
    const kept = findingDetailSchema.parse({ ...detail, evidence: { ...detail.evidence, reason: 'the control matched too' } });
    expect(proofSentence(kept)).toEqual({ proven: false, text: 'Not proven: the control matched too. Kept back from the report.' });
  });
});

describe('actionLabel', () => {
  it('words known ledger actions and passes unknown ones through', () => {
    expect(actionLabel('gate2.deny')).toBe('Denied a request');
    expect(actionLabel('asset.created')).toBe('asset.created');
  });
});
