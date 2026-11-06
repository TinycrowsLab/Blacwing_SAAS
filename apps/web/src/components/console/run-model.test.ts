import { describe as suite, expect, it } from 'vitest';

import {
  agentLanes,
  auditLine,
  candidates,
  conversationItems,
  describe,
  filterConversation,
  killConfirmed,
  liveness,
  mergeEvents,
  hms,
  mmss,
  secondsLeft,
  stages,
  teamNodes,
  testCases,
  type ThreadItem,
  type TurnItem,
  type ValidatorItem,
} from './run-model';

import type { Gate2, RunEvent } from '../../lib/schemas';

const ev = (
  seq: number,
  kind: string,
  stage: string,
  data: Record<string, unknown>,
  at = '2026-11-05T10:00:00.000Z',
): RunEvent => ({
  seq,
  kind,
  stage,
  message: '',
  data,
  at,
});

suite('kill confirmation', () => {
  const runId = '0194ab12-3456-7890-abcd-ef0123456789';
  it('accepts the first 8 characters, any case', () => {
    expect(killConfirmed('0194AB12', runId)).toBe(true);
    expect(killConfirmed(' 0194ab12 ', runId)).toBe(true);
  });
  it('refuses anything else', () => {
    expect(killConfirmed('', runId)).toBe(false);
    expect(killConfirmed('0194ab1', runId)).toBe(false);
    expect(killConfirmed(runId, runId)).toBe(false);
  });
});

suite('gate 2 countdown', () => {
  const deadline = '2026-11-05T10:05:00.000Z';
  it('counts down and never goes negative (expired means denied)', () => {
    expect(secondsLeft(deadline, Date.parse('2026-11-05T10:00:00.000Z'))).toBe(300);
    expect(secondsLeft(deadline, Date.parse('2026-11-05T10:05:01.000Z'))).toBe(0);
  });
  it('formats mm:ss', () => {
    expect(mmss(398)).toBe('06:38');
    expect(mmss(-4)).toBe('00:00');
    expect(hms(4324)).toBe('1h 12m 04s');
    expect(hms(724)).toBe('12m 04s');
  });
});

suite('event mapping', () => {
  it('marks blocked requests as errors with a ring', () => {
    const row = describe(
      ev(1, 'policy.blocked', 'policy', {
        agent: 'recon',
        method: 'DELETE',
        url: 'https://a.example/x',
        rule: 'destructive',
      }),
    );
    expect(row).toMatchObject({ kind: 'Policy', isError: true, mark: 'ring', agent: 'recon' });
  });
  it('flags http errors and ignores agent.turn rows', () => {
    expect(
      describe(
        ev(2, 'http.sent', 'recon', {
          agent: 'recon',
          method: 'GET',
          url: 'https://a.example/p?q=1',
          status: 500,
          bytes: 3,
          ms: 9,
        }),
      )?.isError,
    ).toBe(true);
    expect(
      describe(ev(3, 'agent.turn', 'recon', { agent: 'recon', turns: 1, costUsd: 0.1 })),
    ).toBeNull();
  });
  it('builds lanes with the latest turn totals', () => {
    const lanes = agentLanes([
      ev(1, 'run.started', 'plan', { model: 'm', agents: ['orchestrator', 'recon'] }),
      ev(2, 'agent.turn', 'recon', { agent: 'recon', turns: 2, costUsd: 0.1 }),
      ev(3, 'agent.turn', 'recon', { agent: 'recon', turns: 5, costUsd: 0.3 }),
    ]);
    expect(lanes.map((l) => l.name)).toEqual(['orchestrator', 'recon']);
    expect(lanes[1]).toMatchObject({ turns: 5, costUsd: 0.3 });
  });
  it('tracks a candidate from submission to confirmation', () => {
    const list = candidates([
      ev(1, 'candidate.submitted', 'validator', {
        agent: 'recon',
        candidateId: 'c1',
        title: 'T',
        severity: 'high',
      }),
      ev(2, 'validator.replay', 'validator', {
        candidateId: 'c1',
        n: 2,
        status: 200,
        matched: true,
      }),
    ]);
    expect(list[0]).toMatchObject({ status: 'validating', replays: 2 });
    const done = candidates([
      ev(1, 'candidate.submitted', 'validator', {
        agent: 'recon',
        candidateId: 'c1',
        title: 'T',
        severity: 'high',
      }),
      ev(3, 'finding.confirmed', 'validator', {
        candidateId: 'c1',
        findingId: 'f1',
        title: 'T',
        severity: 'high',
      }),
    ]);
    expect(done[0]).toMatchObject({ status: 'confirmed', findingId: 'f1' });
  });
});

suite('gate 3 and test plan', () => {
  const submitted = ev(1, 'candidate.submitted', 'validator', {
    agent: 'recon',
    candidateId: 'c1',
    title: 'T',
    severity: 'high',
  });
  it('moves a candidate to suspected, released and dismissed', () => {
    const suspected = ev(2, 'finding.suspected', 'validator', {
      candidateId: 'c1',
      findingId: 'f1',
      title: 'T',
    });
    expect(candidates([submitted, suspected])[0]).toMatchObject({
      status: 'suspected',
      findingId: 'f1',
    });
    const released = ev(3, 'finding.released', 'gate3', {
      findingId: 'f1',
      title: 'T',
      auto: false,
    });
    expect(candidates([submitted, suspected, released])[0]?.status).toBe('released');
    const dismissed = ev(4, 'finding.dismissed', 'gate3', { findingId: 'f1', title: 'T' });
    expect(candidates([submitted, suspected, released, dismissed])[0]?.status).toBe('dismissed');
    expect(describe(released)).toMatchObject({ agent: 'gate3', meta: 'Gate 3' });
    expect(describe(ev(5, 'finding.suspected', 'validator', { title: 'T' }))).toMatchObject({
      meta: 'analyst only',
      isError: false,
    });
  });
  it('counts test cases by their latest status', () => {
    const plan = ev(1, 'plan.cases', 'plan', {
      cases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      total: 3,
    });
    const executed = ev(3, 'case.status', 'plan', {
      caseId: 'a',
      status: 'executed',
      by: 'validator',
    });
    const events = [
      plan,
      ev(2, 'case.status', 'plan', { caseId: 'a', status: 'executing', by: 'model' }),
      executed,
      ev(4, 'plan.cases', 'plan', { cases: [{ id: 'a' }, { id: 'd' }], total: 4 }),
    ];
    expect(testCases(events)).toEqual({
      total: 4,
      counts: { executed: 1, executing: 0, proposed: 3, skipped: 0, blocked: 0 },
    });
    expect(describe(plan)?.text).toBe('Recorded 3 test cases (3 in plan)');
    expect(describe(executed)).toMatchObject({
      text: 'Test case a: executed',
      meta: 'by validator',
    });
  });
  it('words the audit line', () => {
    expect(auditLine(null)).toBe('Recorded in the audit ledger');
    expect(
      auditLine({ eventId: '0194ab12-3456-7abc-8def-0123456789ab', hash: 'abcd1234'.repeat(8) }),
    ).toBe('Recorded in the audit ledger · evt_456789ab · sha256:abcd...1234');
  });
});

suite('mergeEvents', () => {
  it('drops repeated seqs and keeps ascending order', () => {
    const a = ev(1, 'http.sent', 'recon', {});
    const b = ev(2, 'http.sent', 'recon', {});
    const c = ev(3, 'http.sent', 'recon', {});
    expect(mergeEvents([a, b], [b, c, c]).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeEvents([b], [a]).map((e) => e.seq)).toEqual([1, 2]);
  });
});

// A run as the worker writes it: the planner maps with recon, records a plan, sends two specialists in parallel.
const T0 = Date.parse('2026-11-05T10:00:00.000Z');
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const URL0 = 'http://127.0.0.1:3001';
const RUN: RunEvent[] = [
  ev(1, 'run.queued', 'queued', {}, at(0)),
  ev(2, 'run.started', 'plan', { model: 'm', agents: ['orchestrator', 'recon', 'web-api-specialist', 'authz-specialist', 'validator'] }, at(1)),
  ev(3, 'agent.message', 'orchestrator', { agent: 'orchestrator', text: 'I will map the site first.' }, at(2)),
  ev(4, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'Agent', toolUseId: 'tu1', input: { subagent: 'recon', description: 'Map', prompt: 'Map the attack surface.' } }, at(3)),
  ev(5, 'http.sent', 'recon', { agent: 'recon', method: 'GET', url: `${URL0}/`, status: 200, ms: 4, exchangeId: 'x1' }, at(4)),
  ev(6, 'http.sent', 'recon', { agent: 'recon', method: 'GET', url: `${URL0}/robots.txt`, status: 200, ms: 3, exchangeId: 'x2' }, at(5)),
  ev(7, 'agent.message', 'recon', { agent: 'recon', text: 'Recon is done.' }, at(6)),
  ev(8, 'agent.reply', 'recon', { agent: 'recon', to: 'orchestrator', toolUseId: 'tu1', text: 'Recon is done.', isError: false }, at(7)),
  ev(9, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'record_test_cases', input: { cases: [{}, {}] } }, at(8)),
  ev(10, 'plan.cases', 'plan', { agent: 'orchestrator', cases: [{ id: 'sqli', agent: 'web-api-specialist', title: 'SQLi' }, { id: 'idor', agent: 'authz-specialist', title: 'IDOR' }], total: 2 }, at(9)),
  ev(11, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'Agent', toolUseId: 'tu2', input: { subagent: 'web-api-specialist', description: 'Injection' } }, at(10)),
  ev(12, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'Agent', toolUseId: 'tu3', input: { subagent: 'authz-specialist', description: 'Access', prompt: 'Check baskets.' } }, at(11)),
  ev(13, 'http.sent', 'web-api-specialist', { agent: 'web-api-specialist', method: 'GET', url: `${URL0}/rest/products/search?q=1`, status: 200, ms: 9, exchangeId: 'x3', asRole: 'customer_a' }, at(12)),
  ev(14, 'policy.blocked', 'policy', { agent: 'web-api-specialist', method: 'DELETE', url: `${URL0}/api/x`, rule: 'destructive_method' }, at(13)),
  ev(15, 'case.status', 'plan', { caseId: 'sqli', status: 'executing', agent: 'web-api-specialist' }, at(14)),
  ev(16, 'candidate.submitted', 'validator', { agent: 'web-api-specialist', candidateId: 'c1', title: 'SQL injection', severity: 'high' }, at(15)),
  ev(17, 'http.sent', 'validator', { agent: 'validator', method: 'GET', url: `${URL0}/rest/products/search?q=1`, status: 200, ms: 5, exchangeId: 'x4' }, at(16)),
  ev(18, 'validator.replay', 'validator', { candidateId: 'c1', n: 1, status: 200, matched: true }, at(16)),
  ev(19, 'validator.replay', 'validator', { candidateId: 'c1', n: 2, status: 200, matched: true }, at(16)),
  ev(20, 'validator.replay', 'validator', { candidateId: 'c1', n: 3, status: 200, matched: true }, at(17)),
  ev(21, 'validator.control', 'validator', { candidateId: 'c1', status: 200, matched: false }, at(17)),
  ev(22, 'finding.confirmed', 'validator', { candidateId: 'c1', findingId: 'f1', title: 'SQL injection', severity: 'high' }, at(18)),
  ev(23, 'case.status', 'plan', { caseId: 'sqli', status: 'executed', agent: 'validator', by: 'validator' }, at(18)),
  ev(24, 'agent.message', 'authz-specialist', { agent: 'authz-specialist', text: 'I need one POST.' }, at(19)),
  ev(25, 'gate2.requested', 'gate2', { agent: 'authz-specialist', gate2Id: 'g1', method: 'POST', url: `${URL0}/api/Users`, body: '{"a":1}', deadlineAt: at(319) }, at(19)),
];
const G1: Gate2 = {
  id: 'g1',
  runId: 'r1',
  agent: 'authz-specialist',
  method: 'POST',
  url: `${URL0}/api/Users`,
  pathKey: 'POST /api/Users as no test account',
  intrusiveness: 'state_changing',
  reason: 'Create a test user',
  whyOutside: '',
  status: 'pending',
  deadlineAt: at(319),
  createdAt: at(19),
  decidedBy: null,
  decidedAt: null,
  secondsLeft: 300,
  decisionReason: null,
};

suite('conversationItems', () => {
  const items = conversationItems(RUN, [G1]);
  const threads = items.filter((i): i is ThreadItem => i.type === 'thread');

  it('opens a thread per delegation with the prompt, else the description', () => {
    expect(threads.map((t) => [t.to, t.task])).toEqual([
      ['recon', 'Map the attack surface.'],
      ['web-api-specialist', 'Injection'],
      ['authz-specialist', 'Check baskets.'],
    ]);
  });

  it('nests turns and calls under the thread and folds an identical reply into the last turn', () => {
    const recon = threads[0];
    expect(recon?.replied).toBe(true);
    expect(recon?.children).toHaveLength(2);
    const [calls, said] = (recon?.children ?? []) as TurnItem[];
    expect(calls).toMatchObject({ text: null, reply: false });
    expect(calls?.calls.map((c) => c.path)).toEqual(['/', '/robots.txt']);
    expect(said).toMatchObject({ text: 'Recon is done.', reply: true });
  });

  it('keeps the planner at top level with its tool chips, and Blackwing lines from the catalogue', () => {
    expect(items[0]).toMatchObject({ type: 'host', text: 'Audit queued. Scope, limits and authorisation are pinned.' });
    expect(items[1]).toMatchObject({ type: 'host', text: "Claude's team started work." });
    const planner = items[2] as TurnItem;
    expect(planner).toMatchObject({ type: 'turn', agent: 'orchestrator', text: 'I will map the site first.' });
    expect(planner.tools).toEqual(['recorded 2 test cases']);
    expect(items.find((i) => i.type === 'host' && i.kind === 'plan.cases')).toMatchObject({
      text: 'The planner recorded 2 test cases (2 in the plan). Read them under Test plan.',
    });
  });

  it('groups calls, blocked rows and the validator turn under the asking specialist', () => {
    const web = threads[1];
    const turn = web?.children[0] as TurnItem;
    expect(turn.calls.map((c) => [c.blocked, c.method, c.asRole, c.rule])).toEqual([
      [false, 'GET', 'customer_a', null],
      [true, 'DELETE', null, 'destructive_method'],
    ]);
    const v = web?.children[1] as ValidatorItem;
    expect(v).toMatchObject({ type: 'validator', verdict: 'proven', replays: 3, matched: 3, findingId: 'f1', control: { matched: false } });
    expect(v.calls.map((c) => c.exchangeId)).toEqual(['x4']);
  });

  it('places the Gate 2 request after the asking turn and closes it with the decision line', () => {
    const authz = threads[2];
    expect(authz?.children.map((c) => c.type)).toEqual(['turn', 'gate2']);
    expect(authz?.children[1]).toMatchObject({ body: '{"a":1}', asRole: null, decided: null });
    const decided = conversationItems([...RUN, ev(26, 'gate2.decided', 'gate2', { gate2Id: 'g1', status: 'expired' }, at(320))], [G1]);
    const g = decided.filter((i): i is ThreadItem => i.type === 'thread')[2]?.children[1];
    expect(g).toMatchObject({ decided: 'Denied automatically: no answer in 5 min.' });
  });

  it('marks unproven candidates kept back with the reason', () => {
    const list = conversationItems(
      [
        ev(1, 'candidate.submitted', 'validator', { agent: 'recon', candidateId: 'c9', title: 'T', severity: 'low' }),
        ev(2, 'finding.suspected', 'validator', { candidateId: 'c9', findingId: 'f9', reason: 'probe replay 2 did not match the oracle' }),
      ],
      [],
    );
    expect(list[0]).toMatchObject({ type: 'validator', verdict: 'not_proven', reason: 'probe replay 2 did not match the oracle' });
  });

  it('filters to one agent', () => {
    expect(filterConversation(items, 'recon').map((i) => i.type === 'thread' && i.to)).toEqual(['recon']);
    expect(filterConversation(items, 'validator').map((i) => i.type)).toEqual(['validator']);
    const planner = filterConversation(items, 'orchestrator');
    expect(planner.filter((i) => i.type === 'thread')).toHaveLength(3);
    expect(planner.find((i): i is ThreadItem => i.type === 'thread')?.children.every((c) => c.type === 'turn' && c.reply)).toBe(true);
  });
});

suite('stages', () => {
  it('marks the latest stage with activity as current', () => {
    const s = stages(RUN, { terminal: false, approvedBy: 'you' });
    expect(s.map((x) => [x.key, x.state, x.label, x.detail])).toEqual([
      ['approved', 'done', 'Approved', 'by you'],
      ['mapping', 'done', 'Mapped', '2 requests'],
      ['planning', 'done', 'Planned', '2 test cases'],
      ['testing', 'done', 'Testing', '1 of 2 done'],
      ['proving', 'current', 'Proving', '1 candidate, 1 proven'],
      ['review', 'upcoming', 'Your review', ''],
    ]);
  });
  it('ends at your review and marks stages a stopped run never reached', () => {
    const s = stages(RUN.slice(0, 3), { terminal: true, approvedBy: null });
    expect(s.map((x) => x.state)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped', 'current']);
    expect(s[0]?.detail).toBe('');
    expect(s[1]?.detail).toBe('not reached');
  });
});

suite('teamNodes', () => {
  it('draws only the manifest and gives each node its state', () => {
    const team = teamNodes(RUN, [G1], T0 + 20_000, false);
    expect(team.planner).toMatchObject({ name: 'Planner', state: 'working', sub: '3 tasks given' });
    expect(team.specialists.map((n) => [n.id, n.state, n.sub])).toEqual([
      ['recon', 'done', 'mapped, 2 requests'],
      ['web-api-specialist', 'working', 'testing /rest/products/search'],
      ['authz-specialist', 'waiting', 'waiting on you'],
    ]);
    expect(team.validator).toMatchObject({ state: 'done', sub: '1 of 1 proven' });
    expect(team).toMatchObject({ tasks: 3, candidates: 1, proven: 1 });
    expect(teamNodes(RUN.slice(0, 1), [], T0, false)).toMatchObject({ planner: null, specialists: [], validator: null });
  });
  it('spins only while the agent spoke in the last 10 s', () => {
    const web = (now: number) => teamNodes(RUN, [], now, false).specialists[1];
    expect(web(T0 + 20_000)).toMatchObject({ state: 'working', spinning: true });
    expect(web(T0 + 30_000)).toMatchObject({ state: 'working', spinning: false });
  });
  it('is no longer waiting once the decision window closed, and done when the run is over', () => {
    expect(teamNodes(RUN, [{ ...G1, status: 'denied' }], T0 + 20_000, false).specialists[2]?.state).toBe('working');
    expect(teamNodes(RUN, [], T0 + 20_000, true).specialists.map((n) => n.state)).toEqual(['done', 'done', 'done']);
  });
});

suite('liveness', () => {
  it('reads live, then quiet, then reconnecting', () => {
    expect(liveness(T0 + 2000, T0, null, T0)).toEqual({ tone: 'live', text: 'Live · last event 2 s ago' });
    expect(liveness(T0 + 15_000, T0, null, T0)).toEqual({ tone: 'quiet', text: 'Quiet for 15 s' });
    expect(liveness(T0 + 12_000, T0, T0 + 3000, T0)).toEqual({ tone: 'reconnecting', text: 'Reconnecting… last update 12 s ago' });
  });
});
