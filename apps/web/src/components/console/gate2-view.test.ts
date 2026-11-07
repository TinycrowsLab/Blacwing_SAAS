import { describe, expect, it } from 'vitest';

import {
  earlierDecision,
  gate2Question,
  grantScope,
  inboxOrder,
  type InboxItem,
  plainWhy,
  roleFromPathKey,
} from './gate2-view';

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

  it('says what an allow really covers: every agent, any body, no further question', () => {
    expect(grantScope({ method: 'POST', url: 'http://x.test/api/Users?x=1' }, null)).toBe(
      "Allowing covers every POST /api/Users sent without signing in, from any agent and with any body, until this audit ends. Claude won't ask about it again.",
    );
    expect(grantScope({ method: 'POST', url: 'http://x.test/rest/basket' }, 'customer_a')).toContain(
      'sent as customer_a',
    );
  });
});

describe('Gate 2 inbox order', () => {
  const item = (id: string, runId: string, deadline: string): InboxItem => ({
    gate2: row({ id, runId, deadlineAt: `2026-11-06T13:${deadline}:00.000Z` }),
    body: null,
    audit: null,
    history: [],
  });

  it('puts the audit with the soonest open deadline first, open requests before settled ones', () => {
    const a1 = item('a1', 'A', '20');
    const a2 = item('a2', 'A', '25');
    const b1 = item('b1', 'B', '22');
    const settled = item('b0', 'B', '10');
    const open = (i: InboxItem): boolean => i.gate2.id !== 'a1' && i.gate2.id !== 'b0';
    const ids = inboxOrder([a1, a2, settled, b1], open).map((g) => g.map((i) => i.gate2.id));
    // a1 is settled, so audit A's soonest open request is a2 (13:25) and B (13:22) comes first.
    expect(ids).toEqual([
      ['b1', 'b0'],
      ['a2', 'a1'],
    ]);
  });
});
