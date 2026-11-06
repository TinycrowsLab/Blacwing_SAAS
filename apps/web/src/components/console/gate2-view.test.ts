import { describe, expect, it } from 'vitest';

import { earlierDecision, gate2Question, plainLead, plainWhy, roleFromPathKey } from './gate2-view';

import type { Gate2 } from '../../lib/schemas';

const row = (over: Partial<Gate2>): Gate2 => ({
  id: 'g',
  runId: 'r',
  agent: 'authz-specialist',
  method: 'POST',
  url: 'http://x.test/api/Users',
  pathKey: 'POST http://x.test/api/Users as no test account',
  intrusiveness: 'state_changing',
  reason: '',
  whyOutside: '',
  status: 'pending',
  deadlineAt: '2026-11-06T13:20:00.000Z',
  createdAt: '2026-11-06T13:15:00.000Z',
  decidedBy: null,
  decidedAt: null,
  secondsLeft: 0,
  decisionReason: null,
  ...over,
});

describe('Gate 2 question', () => {
  it('reads the role from the worker gate key', () => {
    expect(roleFromPathKey('POST https://shop.example/rest/basket/7/checkout as customer_a')).toBe(
      'customer_a',
    );
    expect(roleFromPathKey('POST http://x.test/rest/user/login as no test account')).toBeNull();
    expect(roleFromPathKey('')).toBeNull();
  });

  it('asks with the role, or without signing in', () => {
    expect(gate2Question('customer_a')).toBe('Allow Claude to send this request as customer_a?');
    expect(gate2Question(null)).toBe('Allow Claude to send this request without signing in?');
  });

  it('names the authorisation level by the label people chose it by', () => {
    expect(
      plainWhy(
        'POST is a state-changing method; the authorisation covers only active-safe requests.',
      ),
    ).toBe(
      'POST is a state-changing method; the authorisation covers only “Probe gently” requests.',
    );
  });
});

describe('Gate 2 memory and plain words', () => {
  it('finds the earlier decision for the same method, path and role in the audit', () => {
    const now = row({ id: 'g2' });
    const denied = row({
      id: 'g1',
      status: 'denied',
      decidedBy: 'Jatin',
      decidedAt: '2026-11-06T13:11:00.000Z',
    });
    const other = row({
      id: 'g0',
      status: 'denied',
      pathKey: 'POST http://x.test/rest/user/login as no test account',
    });
    expect(earlierDecision(now, [now, denied, other])?.id).toBe('g1');
    expect(earlierDecision(now, [now, other])).toBeNull();
    // A decision made after this request was raised is not "earlier".
    expect(
      earlierDecision(now, [
        row({ id: 'g3', status: 'denied', decidedAt: '2026-11-06T13:18:00.000Z' }),
      ]),
    ).toBeNull();
  });

  it('leads with one plain line', () => {
    expect(plainLead({ method: 'POST' }, null)).toBe(
      'This could change data on the site, and your plan only lets Claude probe gently. It would go as a visitor, without any test account.',
    );
    expect(plainLead({ method: 'post' }, 'customer_a')).toContain(
      'signed in as your test account “customer_a”',
    );
  });
});
