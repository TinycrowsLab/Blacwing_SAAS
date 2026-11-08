import { describe as suite, expect, it } from 'vitest';

import {
  accountUse,
  blockingAsks,
  caseList,
  caseTally,
  chipGroups,
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
  it('accepts the last 8 characters (the random tail of a UUIDv7), any case', () => {
    expect(killConfirmed('23456789', runId)).toBe(true);
    expect(killConfirmed(' 23456789 ', runId)).toBe(true);
    // The timestamp prefix is shared by runs made in the same minute: it does not confirm.
    expect(killConfirmed('0194ab12', runId)).toBe(false);
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
  body: null,
  asRole: null,
  assetName: null,
  requester: null,
  runStartedAt: null,
  closeReason: null,
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

  it('folds a clipped reply (a prefix of the last turn) into that turn, keeping the full text', () => {
    const long = `${'Mapped the API. '.repeat(300)}End.`;
    const list = conversationItems(
      [
        ...RUN.slice(0, 6),
        ev(7, 'agent.message', 'recon', { agent: 'recon', text: long }, at(6)),
        ev(8, 'agent.reply', 'recon', { agent: 'recon', toolUseId: 'tu1', text: long.slice(0, 4000) }, at(7)),
      ],
      [],
    );
    const said = (list.find((i): i is ThreadItem => i.type === 'thread')?.children ?? []).filter((c): c is TurnItem => c.type === 'turn' && c.text !== null);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ text: long, reply: true });
  });

  it('keeps a different reply as its own turn', () => {
    const list = conversationItems([...RUN.slice(0, 7), ev(8, 'agent.reply', 'recon', { agent: 'recon', toolUseId: 'tu1', text: 'Here is the map.' }, at(7))], []);
    const turns = (list.find((i): i is ThreadItem => i.type === 'thread')?.children ?? []).filter((c): c is TurnItem => c.type === 'turn' && c.text !== null);
    expect(turns.map((t) => [t.text, t.reply])).toEqual([
      ['Recon is done.', false],
      ['Here is the map.', true],
    ]);
  });

  it('keeps the planner at top level, and Blackwing lines from the catalogue at the moment they happened', () => {
    expect(items[0]).toMatchObject({ type: 'host', text: 'Audit queued. Scope, limits and authorisation are pinned.' });
    expect(items[1]).toMatchObject({ type: 'host', text: "Claude's team started work." });
    const planner = items[2] as TurnItem;
    expect(planner).toMatchObject({ type: 'turn', agent: 'orchestrator', text: 'I will map the site first.' });
    // Recording the plan happened after recon reported back: no chip on the first turn, the plan line after the thread.
    expect(planner.tools).toEqual([]);
    expect(items[3]).toMatchObject({ type: 'thread', to: 'recon' });
    expect(items[4]).toMatchObject({ type: 'host', kind: 'plan.cases', text: 'The planner recorded 2 test cases (2 in the plan).' });
  });

  it('opens a new planner turn for a chip that comes after other items', () => {
    const list = conversationItems([...RUN.slice(0, 8), ev(9, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'TodoWrite', input: {} }, at(8))], []);
    expect(list.at(-1)).toMatchObject({ type: 'turn', agent: 'orchestrator', text: null, tools: ['updated its to-do list'] });
    expect((list[2] as TurnItem).tools).toEqual([]);
  });

  it('reads down in time: a thread resumes in a continued segment below items that came after it', () => {
    const list = conversationItems(
      [
        ...RUN.slice(0, 8),
        ev(9, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'Agent', toolUseId: 'tA', input: { subagent: 'authz-specialist', prompt: 'A' } }, at(20)),
        ev(10, 'agent.message', 'authz-specialist', { agent: 'authz-specialist', text: 'Started.' }, at(25)),
        ev(11, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'Agent', toolUseId: 'tB', input: { subagent: 'web-api-specialist', prompt: 'B' } }, at(140)),
        ev(12, 'candidate.submitted', 'validator', { agent: 'authz-specialist', candidateId: 'c1', title: 'IDOR', severity: 'high' }, at(150)),
        ev(13, 'agent.reply', 'authz-specialist', { agent: 'authz-specialist', toolUseId: 'tA', text: 'Found one.' }, at(160)),
      ],
      [],
    );
    const shape = list.slice(4).map((i) => (i.type === 'thread' ? `${i.continued ? '+' : ''}${i.to}:${i.children.map((c) => c.type).join(',')}` : i.type));
    expect(shape).toEqual(['authz-specialist:turn', 'web-api-specialist:', '+authz-specialist:validator,turn']);
    const segs = list.filter((i): i is ThreadItem => i.type === 'thread' && i.to === 'authz-specialist');
    expect(segs.every((t) => t.replied && t.root === segs[0]?.root)).toBe(true);
    const times = list.flatMap((i) => (i.type === 'thread' ? [i.at, ...i.children.map((c) => c.at)] : [i.at])).map((t) => Date.parse(t));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('folds repeated chips', () => {
    expect(chipGroups(['marked a test case blocked', 'marked a test case blocked', 'used X', 'used X', 'used Y'])).toEqual([
      'marked 2 test cases blocked',
      'used X ×2',
      'used Y',
    ]);
  });

  it("places the planner's note on delegations it just made before those open threads", () => {
    const list = conversationItems(
      [
        ...RUN.slice(0, 4),
        ev(5, 'agent.message', 'orchestrator', { agent: 'orchestrator', text: 'Recon is running; I am waiting.' }, at(4)),
        ...RUN.slice(4, 8),
      ],
      [],
    );
    expect(list.map((i) => (i.type === 'thread' ? `thread:${i.to}` : i.type === 'turn' ? i.text : i.type))).toEqual([
      'host',
      'host',
      'I will map the site first.',
      'Recon is running; I am waiting.',
      'thread:recon',
    ]);
  });

  it('words test-case updates instead of showing case ids', () => {
    const list = conversationItems(
      [ev(1, 'agent.tool', 'orchestrator', { agent: 'orchestrator', tool: 'update_test_case', input: { id: 'tc-login-sqli', status: 'executed' } })],
      [],
    );
    expect((list[0] as TurnItem).tools).toEqual(['finished a test case']);
  });

  it('puts a call sent after a decision after its receipt', () => {
    const list = conversationItems(
      [
        ...RUN,
        ev(26, 'gate2.decided', 'gate2', { gate2Id: 'g1', status: 'approved', by: 'u1' }, at(30)),
        ev(27, 'http.sent', 'authz-specialist', { agent: 'authz-specialist', method: 'POST', url: `${URL0}/api/Users`, status: 201, ms: 7, exchangeId: 'x9' }, at(31)),
      ],
      [{ ...G1, status: 'approved' }],
    );
    const authz = list.filter((i): i is ThreadItem => i.type === 'thread')[2];
    expect(authz?.children.map((c) => c.type)).toEqual(['turn', 'gate2', 'turn']);
    expect((authz?.children[2] as TurnItem).calls.map((c) => c.exchangeId)).toEqual(['x9']);
  });

  it('says "you" for the viewer in Blackwing lines', () => {
    const list = conversationItems([{ ...ev(1, 'run.paused', 'run', {}), message: 'Run paused by Jatin Singh.' }], [], 'Jatin Singh');
    expect(list[0]).toMatchObject({ type: 'host', text: 'Paused by you.' });
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
      ['testing', 'active', 'Testing', '1 of 2 done'],
      ['proving', 'current', 'Proving', '1 candidate, 1 proven'],
      ['review', 'upcoming', 'Your review', ''],
    ]);
  });
  it('ends at your review and marks stages a stopped run never reached', () => {
    const s = stages(RUN.slice(0, 3), { terminal: true, approvedBy: null });
    expect(s.map((x) => x.state)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped', 'done']);
    expect(s.at(-1)).toMatchObject({ detail: 'nothing to review' });
    expect(stages(RUN.slice(0, 3), { terminal: true, approvedBy: null, stopped: true }).at(-1)).toMatchObject({ state: 'stopped' });
    expect(s[0]?.detail).toBe('');
    expect(s[1]?.detail).toBe('not reached');
  });
  it('never ticks work a stopped run left open', () => {
    const s = stages(RUN, { terminal: true, approvedBy: 'you', stopped: true });
    expect(s.find((x) => x.key === 'testing')).toMatchObject({ state: 'stopped', label: 'Testing', detail: 'stopped at 1 of 2' });
    // A run that finished on its own left cases undone, but nothing was stopped.
    expect(stages(RUN, { terminal: true, approvedBy: 'you' }).find((x) => x.key === 'testing')).toMatchObject({ detail: '1 of 2 done' });
    expect(s.find((x) => x.key === 'proving')).toMatchObject({ state: 'done', label: 'Proved' });
    expect(s.at(-1)).toMatchObject({ state: 'current' });
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
  it('agrees with the spine: recon is done once the plan is recorded, even without a reply', () => {
    const noReply = RUN.filter((e) => e.kind !== 'agent.reply');
    expect(teamNodes(noReply.slice(0, 7), [], T0 + 7000, false).specialists[0]).toMatchObject({ id: 'recon', state: 'working' });
    expect(teamNodes(noReply, [], T0 + 20_000, false).specialists[0]).toMatchObject({ id: 'recon', state: 'done' });
    expect(stages(noReply, { terminal: false, approvedBy: 'you' }).find((x) => x.key === 'mapping')).toMatchObject({ state: 'done', label: 'Mapped' });
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
  it('shows agents a stop interrupted as stopped, not done', () => {
    const team = teamNodes(RUN, [], T0 + 20_000, true, true);
    expect(team.planner).toMatchObject({ state: 'stopped', sub: '3 tasks given' });
    expect(team.specialists.map((n) => [n.id, n.state])).toEqual([
      ['recon', 'done'],
      ['web-api-specialist', 'stopped'],
      ['authz-specialist', 'stopped'],
    ]);
    expect(team.autoReleased).toBe(false);
    expect(teamNodes([...RUN, ev(26, 'finding.released', 'gate3', { findingId: 'f1', auto: true })], [], T0, false).autoReleased).toBe(true);
  });
});

suite('client-ready run view', () => {
  const free = (e: RunEvent): RunEvent => (e.kind === 'gate2.requested' ? { ...e, data: { ...e.data, blocking: false } } : e);
  it('a non-blocking ask leaves the agent testing, and says it asked', () => {
    const team = teamNodes(RUN.map((e) => free(e)), [G1], T0 + 20_000, false);
    expect(team.specialists[2]).toMatchObject({ id: 'authz-specialist', state: 'working' });
    expect(team.specialists[2]?.sub).toMatch(/^asked you · /);
    expect(blockingAsks(RUN.map((e) => free(e)), [G1])).toEqual([]);
    expect(blockingAsks(RUN, [G1])).toEqual([G1]);
  });
  it('stops every ring while paused', () => {
    expect(teamNodes(RUN, [], T0 + 20_000, false, false, true).specialists[1]).toMatchObject({ state: 'working', spinning: false });
  });
  it('keeps a proven issue proven after a person dismisses it', () => {
    const dismissed = [...RUN, ev(26, 'finding.dismissed', 'gate3', { findingId: 'f1' }, at(30))];
    expect(teamNodes(dismissed, [], T0 + 40_000, true).proven).toBe(1);
    expect(candidates(dismissed)[0]).toMatchObject({ status: 'dismissed', proven: true });
    // Released by hand without proof: never counted as proven.
    const handReleased = [
      ...RUN.slice(0, 16),
      ev(17, 'finding.suspected', 'validator', { candidateId: 'c1', findingId: 'f9', reason: 'no match' }, at(17)),
      ev(18, 'finding.released', 'gate3', { findingId: 'f9' }, at(18)),
    ];
    expect(teamNodes(handReleased, [], T0 + 40_000, true).proven).toBe(0);
  });
  it('counts the cases from the runner coverage, and the requests sent as each role', () => {
    expect(caseTally(RUN)).toEqual({ executed: 1, skipped: 0, total: 2 });
    const cov = ev(30, 'coverage.summary', 'done', {
      cases: [{ id: 'sqli', status: 'executed' }, { id: 'idor', status: 'not_run' }, { id: 'xss', status: 'not_run' }],
    });
    expect(caseTally([...RUN, cov])).toEqual({ executed: 1, skipped: 0, total: 3 });
    // The runner's word wins over the agents' own case statuses, so the plan tab, header and finish line agree.
    const skip = ev(30, 'coverage.summary', 'done', {
      cases: [{ id: 'sqli', status: 'executed' }, { id: 'idor', status: 'skipped', note: 'no second user' }],
    });
    expect(caseList([...RUN, skip]).map((c) => [c.id, c.status, c.note])).toEqual([
      ['sqli', 'executed', ''],
      ['idor', 'skipped', 'no second user'],
    ]);
    const planDone = conversationItems([...RUN, skip, ev(31, 'run.completed', 'done', {}, at(40))], []);
    expect(planDone.at(-1)).toMatchObject({
      type: 'host',
      text: 'Finished: Claude finished its plan: it ran 1 of 2 planned test cases and skipped 1. Your results are ready.',
    });
    expect([...accountUse(RUN)]).toEqual([['customer_a', 1]]);
    const done = conversationItems([...RUN, cov, ev(31, 'run.completed', 'done', {}, at(40))], []);
    expect(done.at(-1)).toMatchObject({ type: 'host', text: 'Finished: Claude ended the audit early: it ran 1 of 3 planned test cases. Your results are ready.' });
  });
  it('says when an allowed non-blocking request was actually sent', () => {
    const events = [
      ...RUN.map((e) => free(e)),
      ev(26, 'gate2.decided', 'gate2', { gate2Id: 'g1', status: 'approved', by: 'u1' }, at(25)),
      ev(27, 'http.sent', 'authz-specialist', { agent: 'authz-specialist', method: 'POST', url: `${URL0}/api/Users`, status: 201, gate2Id: 'g1' }, at(26)),
    ];
    const find = (items: ReturnType<typeof conversationItems>) =>
      items.flatMap((i) => (i.type === 'thread' ? i.children : [i])).find((c) => c.type === 'gate2');
    expect(find(conversationItems(events, [G1]))).toMatchObject({ nonBlocking: true, sentAt: at(26), runEnded: false });
    expect(find(conversationItems(events.slice(0, -1), [G1]))).toMatchObject({ sentAt: null });
  });
});

suite('liveness', () => {
  it('reads live, then quiet, then reconnecting, and nothing else', () => {
    expect(liveness(T0 + 2000, T0, null, T0)).toEqual({ tone: 'live', text: 'Live · last event 2 s ago', short: 'Live' });
    expect(liveness(T0 + 15_000, T0, null, T0)).toEqual({ tone: 'quiet', text: 'Quiet for 15 s', short: 'Quiet for 15 s' });
    expect(liveness(T0 + 12_000, T0, T0 + 3000, T0)).toEqual({ tone: 'reconnecting', text: 'Reconnecting… last update 12 s ago', short: 'Reconnecting…' });
  });
});
