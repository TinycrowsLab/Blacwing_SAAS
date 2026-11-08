import { describe, expect, it } from 'vitest';

import { askOf, ownerOf, type RunAsks } from './asked';

import type { Gate2 } from '../../../lib/schemas';

const g = (over: Partial<Gate2>): Gate2 => ({
  id: 'g1',
  runId: 'r1',
  agent: 'authz-specialist',
  method: 'POST',
  url: 'http://x.test/api/Users',
  pathKey: '',
  intrusiveness: 'state_changing',
  reason: '',
  whyOutside: '',
  status: 'pending',
  deadlineAt: '2026-11-08T10:05:00.000Z',
  decidedBy: null,
  decidedAt: null,
  secondsLeft: 0,
  decisionReason: null,
  body: null,
  asRole: null,
  assetName: null,
  requester: null,
  runStartedAt: null,
  closeReason: null,
  ...over,
});

describe('whose audit asked', () => {
  it('reads the owner from the Gate 2 answer', () => {
    const requester = { id: 'u1', name: 'Avery' };
    expect(ownerOf(g({ requester }), 'u1')).toEqual({ name: 'Avery', mine: true });
    expect(ownerOf(g({ requester }), 'u2')).toEqual({ name: 'Avery', mine: false });
    expect(ownerOf(g({ requester, run: { id: 'r1', viewerIsRequester: true } }), null)).toEqual({ name: 'Avery', mine: true });
    expect(ownerOf(g({ requester: { id: 'u3', name: null } }), 'u1')).toEqual({ name: 'a teammate', mine: false });
  });

  it('says nothing when it cannot tell (older answers, or no viewer id)', () => {
    expect(ownerOf(g({}), 'u1')).toBeNull();
    expect(ownerOf(g({ requester: { id: 'u1', name: 'Avery' } }), null)).toBeNull();
  });
});

describe('what was asked', () => {
  const asks: RunAsks = {
    asked: new Map([['g1', { body: '{"email":"a@x.test"}', asRole: 'alice' }]]),
    audit: null,
    history: [],
    complete: true,
  };

  it('prefers the Gate 2 answer, then the run event, else leaves the role unknown', () => {
    expect(askOf(g({ body: '{"a":1}', asRole: null }), asks)).toEqual({ body: '{"a":1}', asRole: null });
    expect(askOf(g({}), asks)).toEqual({ body: '{"email":"a@x.test"}', asRole: 'alice' });
    expect(askOf(g({ id: 'other' }), asks)).toEqual({ body: null, asRole: undefined });
    expect(askOf(g({ id: 'other', asRole: 'bob' }), undefined)).toEqual({ body: null, asRole: 'bob' });
  });
});
