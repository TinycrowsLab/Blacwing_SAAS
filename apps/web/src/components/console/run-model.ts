/* Presentational values (window sizes, truncation) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
// Pure functions that turn the run DTO and its events (docs/poc/AI_HUNT_POC.md section 2) into what the run screens
// draw. No React here, so the rules (kill confirmation, countdown, lane marks) are unit tested.
import { z } from 'zod';

import { agentName } from '../../lib/agents';
import { hostLine } from '../../lib/host-lines';

import type { Gate2, RunEvent } from '../../lib/schemas';

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);
export const LANE_WINDOW_S = 120;

/** The kill confirmation is the first 8 characters of the run id (the API enforces the same rule). */
export function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export function killConfirmed(typed: string, runId: string): boolean {
  return typed.trim().toLowerCase() === runId.slice(0, 8).toLowerCase();
}

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Elapsed time as the design shows it: `1h 12m 04s`, or `12m 04s` under an hour. */
export function hms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, '0');
  return `${h > 0 ? `${h}h ` : ''}${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Seconds until a Gate 2 deadline. Zero means the decision window is over: no decision is a denial. */
export function secondsLeft(deadlineAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - nowMs) / 1000));
}

/** Merge polled events into the list: unique by seq, ascending. Overlapping polls can return the same rows. */
export function mergeEvents(
  prev: readonly RunEvent[],
  next: readonly RunEvent[],
): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const e of [...prev, ...next]) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19);
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export type MarkShape = 'circle' | 'square' | 'ring' | 'diamond';
type ActivityKind =
  'HTTP' | 'Tool' | 'Policy' | 'Gate 2' | 'Finding' | 'Validator' | 'Agent' | 'Run';

export interface Activity {
  readonly seq: number;
  readonly at: string;
  readonly agent: string;
  readonly kind: ActivityKind;
  readonly text: string;
  readonly meta: string;
  readonly isError: boolean;
  readonly mark: MarkShape | null;
}

/** One row per event worth showing; `agent.turn` is a running total and has no row. */
export function describe(e: RunEvent): Activity | null {
  const d = e.data;
  const agent = str(d.agent) || e.stage;
  const base = { seq: e.seq, at: e.at, agent, isError: false, mark: null };
  switch (e.kind) {
    case 'http.sent': {
      const status = num(d.status);
      return {
        ...base,
        kind: 'HTTP',
        text: `${str(d.method)} ${pathOf(str(d.url))}`,
        meta: `${status}, ${num(d.bytes)} B, ${num(d.ms)} ms`,
        isError: status >= 400 || status === 0,
        mark: 'circle',
      };
    }
    case 'agent.tool':
      return {
        ...base,
        kind: 'Tool',
        text: str(d.subagent)
          ? `Delegated to ${str(d.subagent)}: ${str(d.description)}`
          : str(d.tool),
        meta: '',
        mark: 'square',
      };
    case 'agent.message':
      return { ...base, kind: 'Agent', text: str(d.text), meta: 'not verified' };
    case 'policy.blocked':
      return {
        ...base,
        kind: 'Policy',
        text: `Blocked ${str(d.method)} ${str(d.url)}. Request not sent.`,
        meta: str(d.rule),
        isError: true,
        mark: 'ring',
      };
    case 'gate2.requested':
      return {
        ...base,
        kind: 'Gate 2',
        text: `Requested approval for ${str(d.method)} ${pathOf(str(d.url))}`,
        meta: '',
      };
    case 'gate2.decided': {
      const denied = str(d.status) !== 'approved';
      return {
        ...base,
        agent: 'gate2',
        kind: 'Gate 2',
        text: `Decision: ${str(d.status)}`,
        meta: '',
        isError: denied,
        mark: denied ? 'ring' : null,
      };
    }
    case 'candidate.submitted':
      return {
        ...base,
        kind: 'Finding',
        text: `Candidate (${str(d.severity)}): ${str(d.title)}`,
        meta: '',
        mark: 'diamond',
      };
    case 'validator.replay':
      return {
        ...base,
        agent: 'validator',
        kind: 'Validator',
        text: `Replay ${num(d.n)} of 3`,
        meta: d.matched === true ? 'matched' : 'no match',
      };
    case 'validator.control':
      return {
        ...base,
        agent: 'validator',
        kind: 'Validator',
        text: 'Negative control',
        meta: d.matched === true ? 'matched (bad)' : 'no match (good)',
      };
    case 'finding.confirmed':
      return {
        ...base,
        agent: 'validator',
        kind: 'Finding',
        text: `Confirmed: ${str(d.title)}`,
        meta: '',
        mark: 'diamond',
      };
    case 'finding.not_confirmed':
      return {
        ...base,
        agent: 'validator',
        kind: 'Finding',
        text: `Not confirmed: ${str(d.title)}`,
        meta: '',
        isError: true,
        mark: 'diamond',
      };
    case 'finding.suspected':
      return {
        ...base,
        agent: 'validator',
        kind: 'Finding',
        text: `Suspected: ${str(d.title)}`,
        meta: 'analyst only',
        mark: 'diamond',
      };
    case 'finding.released': {
      const auto = d.auto === true;
      return {
        ...base,
        agent: auto ? 'validator' : 'gate3',
        kind: 'Finding',
        text: `Released: ${str(d.title)}`,
        meta: auto ? 'auto, proven by replay' : 'Gate 3',
        mark: 'diamond',
      };
    }
    case 'finding.dismissed':
      return {
        ...base,
        agent: 'gate3',
        kind: 'Finding',
        text: `Dismissed: ${str(d.title)}`,
        meta: 'Gate 3',
        mark: 'diamond',
      };
    case 'plan.cases':
      return {
        ...base,
        kind: 'Tool',
        text: `Recorded ${Array.isArray(d.cases) ? d.cases.length : 0} test cases (${num(d.total)} in plan)`,
        meta: '',
        mark: 'square',
      };
    case 'case.status':
      return {
        ...base,
        kind: 'Tool',
        text: `Test case ${str(d.caseId)}: ${str(d.status)}`,
        meta: d.by === 'validator' ? 'by validator' : '',
      };
    case 'run.failed':
      return {
        ...base,
        agent: 'run',
        kind: 'Run',
        text: `Run failed: ${str(d.reason)}`,
        meta: '',
        isError: true,
      };
    case 'run.killed':
      return {
        ...base,
        agent: 'run',
        kind: 'Run',
        text: e.message === '' ? 'Run killed' : e.message,
        meta: `${num(d.haltMs)} ms`,
        isError: true,
      };
    case 'kill.requested':
    case 'run.paused':
    case 'run.resumed':
      return {
        ...base,
        agent: 'run',
        kind: 'Run',
        text: e.message === '' ? e.kind.replace('run.', 'Run ') : e.message,
        meta: '',
      };
    case 'run.queued':
    case 'run.started':
    case 'run.completed':
      return { ...base, agent: 'run', kind: 'Run', text: e.kind.replace('run.', 'Run '), meta: '' };
    default:
      return null;
  }
}

export interface AgentLane {
  readonly name: string;
  readonly turns: number;
  readonly costUsd: number;
  readonly task: string;
  /** The validator is code, not a model: no turns or cost. */
  readonly deterministic: boolean;
  readonly marks: readonly {
    readonly seq: number;
    readonly at: number;
    readonly shape: MarkShape;
    readonly title: string;
  }[];
}

/** The agents named by the `run.started` manifest, in its order. Empty until the run starts: nothing is guessed. */
export function manifest(events: readonly RunEvent[]): string[] {
  const started = events.find((e) => e.kind === 'run.started');
  return Array.isArray(started?.data.agents)
    ? (started.data.agents as unknown[]).map((a) => str(a)).filter((a) => a !== '')
    : [];
}

/** Lanes are the agents named by `run.started`, with the latest turn totals and message. */
export function agentLanes(events: readonly RunEvent[]): AgentLane[] {
  return manifest(events).map((name) => {
    const mine = events.filter((e) => (str(e.data.agent) || e.stage) === name);
    const turn = mine.findLast((e) => e.kind === 'agent.turn');
    const message = mine.findLast((e) => e.kind === 'agent.message');
    const marks = mine.flatMap((e) => {
      const row = describe(e);
      return row?.mark
        ? [{ seq: e.seq, at: new Date(e.at).getTime(), shape: row.mark, title: row.text }]
        : [];
    });
    const deterministic = name === 'validator';
    const latest = deterministic ? events.findLast((e) => describe(e)?.agent === name) : undefined;
    return {
      name,
      turns: num(turn?.data.turns),
      costUsd: num(turn?.data.costUsd),
      task: deterministic ? ((latest && describe(latest)?.text) ?? '') : str(message?.data.text),
      deterministic,
      marks,
    };
  });
}

export interface Candidate {
  readonly candidateId: string;
  readonly title: string;
  readonly severity: string;
  readonly status:
    'validating' | 'confirmed' | 'released' | 'suspected' | 'dismissed' | 'not_confirmed';
  readonly replays: number;
  readonly findingId: string | null;
}

const CANDIDATE_STATUS: Readonly<Record<string, Candidate['status']>> = {
  'finding.confirmed': 'confirmed',
  'finding.released': 'released',
  'finding.suspected': 'suspected',
  'finding.dismissed': 'dismissed',
  'finding.not_confirmed': 'not_confirmed',
};

/** Candidate findings come from validator events, so unconfirmed ones show too. Gate 3 events may carry only a findingId. */
export function candidates(events: readonly RunEvent[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const e of events) {
    const findingId = str(e.data.findingId) || null;
    const id =
      str(e.data.candidateId) ||
      ([...byId.values()].find((c) => findingId !== null && c.findingId === findingId)
        ?.candidateId ??
        '');
    if (id === '') continue;
    const prev = byId.get(id);
    const status = CANDIDATE_STATUS[e.kind];
    if (e.kind === 'candidate.submitted') {
      byId.set(id, {
        candidateId: id,
        title: str(e.data.title),
        severity: str(e.data.severity),
        status: 'validating',
        replays: 0,
        findingId: null,
      });
    } else if (prev && e.kind === 'validator.replay') {
      byId.set(id, { ...prev, replays: Math.max(prev.replays, num(e.data.n)) });
    } else if (prev && status !== undefined) {
      byId.set(id, {
        ...prev,
        status,
        findingId: findingId ?? prev.findingId,
      });
    }
  }
  return [...byId.values()];
}

export const CASE_STATUSES = ['executed', 'executing', 'proposed', 'skipped', 'blocked'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface TestCase {
  readonly id: string;
  readonly title: string;
  /** The agent the planner gave it to. */
  readonly agent: string;
  readonly target: string;
  readonly status: string;
  readonly note: string;
}

/** The test plan as recorded: every case starts proposed, `case.status` events move it. */
export function caseList(events: readonly RunEvent[]): TestCase[] {
  const byId = new Map<string, TestCase>();
  for (const e of events) {
    if (e.kind === 'plan.cases' && Array.isArray(e.data.cases)) {
      for (const c of e.data.cases as Record<string, unknown>[]) {
        const id = str(c.id);
        if (id !== '' && !byId.has(id))
          byId.set(id, { id, title: str(c.title), agent: str(c.agent), target: str(c.target), status: 'proposed', note: '' });
      }
    } else if (e.kind === 'case.status') {
      const id = str(e.data.caseId);
      const prev = byId.get(id) ?? { id, title: '', agent: '', target: '', status: 'proposed', note: '' };
      byId.set(id, { ...prev, status: str(e.data.status), note: str(e.data.note) || prev.note });
    }
  }
  return [...byId.values()];
}

export function testCases(events: readonly RunEvent[]): {
  total: number;
  counts: Record<CaseStatus, number>;
} {
  const list = caseList(events);
  const counts = { executed: 0, executing: 0, proposed: 0, skipped: 0, blocked: 0 };
  for (const c of list) if (c.status in counts) counts[c.status as CaseStatus] += 1;
  return { total: list.length, counts };
}

/** The one line shown after a gated decision: the ledger event id and a shortened hash. */
/** UUIDv7 ids start with their timestamp, so the random tail tells ledger events apart. */
export function auditEventLabel(eventId: string): string {
  return eventId.replace(/-/g, '').slice(-8);
}

export function auditLine(audit: { eventId: string; hash: string } | null): string {
  if (audit === null) return 'Recorded in the audit ledger';
  return `Recorded in the audit ledger · evt_${auditEventLabel(audit.eventId)} · sha256:${audit.hash.slice(0, 4)}...${audit.hash.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Watch Claude work (experience spec §5): the conversation, the stage spine and the team map, all derived from the
// run's events. Nothing here invents a step: an item exists only because an event says so.

/** The validator replays every probe this many times (worker hunt/validator.ts). */
export const VALIDATOR_REPLAYS = 3;
/** A team node spins only while its lane spoke within this window. */
export const SPIN_WINDOW_MS = 10_000;
/** Liveness turns to "Quiet" after this long without an event. */
export const QUIET_AFTER_MS = 15_000;

const RULE_WORDS: Readonly<Record<string, string>> = {
  out_of_scope_origin: 'another site, outside the scope',
  excluded_path: 'a path you excluded',
  destructive_method: 'destructive requests are never sent',
  above_max_intrusiveness: 'above the care level you chose',
  unknown_role: 'no test account has that role',
  request_budget: 'the request limit is reached',
  gate2_required: 'it needs your decision',
  credentials_in_url: 'a username and password in the address',
  scheme_not_allowed: 'only http and https are tested',
  invalid_url: 'not a valid address',
};

/** A `policy.blocked` rule in words; an unknown rule shows as itself. */
export const ruleWords = (rule: string): string => RULE_WORDS[rule] ?? rule.replace(/_/g, ' ');

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A non-delegation tool call as a short chip under the turn that made it. */
export function toolChip(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'record_test_cases':
      return `recorded ${plural(Array.isArray(input.cases) ? input.cases.length : 0, 'test case', 'test cases')}`;
    case 'update_test_case':
      return str(input.id) === '' ? 'updated a test case' : `marked ${str(input.id)} ${str(input.status) || 'updated'}`;
    case 'submit_candidate':
      return str(input.title) === '' ? 'submitted a candidate' : `submitted a candidate: ${str(input.title)}`;
    case 'list_exchanges':
      return 'looked back at earlier requests';
    case 'TodoWrite':
      return 'updated its to-do list';
    default:
      return `used ${tool}`;
  }
}

export interface CallRow {
  readonly seq: number;
  readonly at: string;
  readonly blocked: boolean;
  readonly method: string;
  readonly path: string;
  readonly asRole: string | null;
  readonly status: number | null;
  readonly ms: number | null;
  readonly exchangeId: string | null;
  readonly rule: string | null;
}

export interface TurnItem {
  readonly type: 'turn';
  readonly key: string;
  readonly seq: number;
  readonly at: string;
  readonly agent: string;
  /** Null when the agent made calls without a message: the calls show under its name. */
  text: string | null;
  /** The subagent's report back to the planner (`agent.reply`). */
  reply: boolean;
  isError: boolean;
  readonly calls: CallRow[];
  readonly tools: string[];
}

export interface ValidatorItem {
  readonly type: 'validator';
  readonly key: string;
  readonly seq: number;
  readonly at: string;
  readonly candidateId: string;
  readonly title: string;
  readonly severity: string;
  /** The highest replay number seen, and how many replays matched the oracle. */
  replays: number;
  matched: number;
  control: { readonly status: number; readonly matched: boolean } | null;
  verdict: 'proving' | 'proven' | 'not_proven';
  reason: string | null;
  autoReleased: boolean;
  findingId: string | null;
  readonly calls: CallRow[];
}

export interface Gate2Item {
  readonly type: 'gate2';
  readonly key: string;
  readonly seq: number;
  readonly at: string;
  readonly gate2Id: string;
  readonly agent: string;
  readonly method: string;
  readonly url: string;
  readonly body: string;
  readonly asRole: string | null;
  /** The Blackwing line once `gate2.decided` arrived; until then the decision card shows. */
  decided: string | null;
}

export interface HostItem {
  readonly type: 'host';
  readonly key: string;
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly text: string;
}

export type ThreadChild = TurnItem | ValidatorItem | Gate2Item | HostItem;

export interface ThreadItem {
  readonly type: 'thread';
  readonly key: string;
  readonly seq: number;
  readonly at: string;
  readonly from: string;
  readonly to: string;
  /** The delegation's instruction (`prompt`), or its short description when the planner gave no prompt. */
  readonly task: string;
  readonly toolUseId: string | null;
  replied: boolean;
  readonly children: ThreadChild[];
}

export type ConversationItem = ThreadItem | ThreadChild;

const isDelegation = (e: RunEvent): boolean => e.kind === 'agent.tool' && (str(e.data.tool) === 'Agent' || str(e.data.tool) === 'Task');
const inputOf = (e: RunEvent): Record<string, unknown> =>
  typeof e.data.input === 'object' && e.data.input !== null ? (e.data.input as Record<string, unknown>) : {};
const subagentOf = (e: RunEvent): string => str(inputOf(e).subagent) || 'general-purpose';
const sameText = (a: string | null, b: string): boolean => a !== null && a.trim() === b.trim();

function callOf(e: RunEvent): CallRow {
  const d = e.data;
  const blocked = e.kind === 'policy.blocked';
  return {
    seq: e.seq,
    at: e.at,
    blocked,
    method: str(d.method).toUpperCase(),
    path: pathOf(str(d.url)),
    asRole: str(d.asRole) || null,
    status: blocked ? null : num(d.status),
    ms: blocked ? null : num(d.ms),
    exchangeId: str(d.exchangeId) || null,
    rule: blocked ? str(d.rule) : null,
  };
}

/**
 * The run as a conversation (spec §5.2 item 5). A delegation opens a thread (Planner → specialist); the specialist's
 * messages, calls, tool chips, its candidates' validator turns and its Gate 2 requests nest under the newest open
 * thread to that agent; `agent.reply` closes the thread (matched by toolUseId, else the newest open one). Blackwing's
 * own lines come only from the host-line catalogue. Items keep event order; a thread sits where it was opened.
 * shortcut: calls attach to the lane's latest turn, so two parallel delegations to one subagent share a thread's
 * calls; upgrade when http.sent carries the toolUseId.
 */
export function conversationItems(events: readonly RunEvent[], gate2: readonly Gate2[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const threads: ThreadItem[] = [];
  const turnOf = new Map<string, TurnItem>();
  const validators = new Map<string, ValidatorItem>();
  const findingToCandidate = new Map<string, string>();
  const gate2Items = new Map<string, Gate2Item>();
  let lastValidator: ValidatorItem | null = null;

  const openThread = (lane: string): ThreadItem | undefined =>
    threads.findLast((t) => t.to === lane && !t.replied) ?? threads.findLast((t) => t.to === lane);
  const push = (lane: string, item: ThreadChild): void => {
    const thread = lane === 'orchestrator' ? undefined : openThread(lane);
    if (thread === undefined) items.push(item);
    else thread.children.push(item);
  };
  const turnFor = (lane: string, e: RunEvent): TurnItem => {
    const existing = turnOf.get(lane);
    if (existing !== undefined) return existing;
    const turn: TurnItem = { type: 'turn', key: `t${e.seq}`, seq: e.seq, at: e.at, agent: lane, text: null, reply: false, isError: false, calls: [], tools: [] };
    push(lane, turn);
    turnOf.set(lane, turn);
    return turn;
  };
  const host = (e: RunEvent, text: string | null): void => {
    if (text !== null) items.push({ type: 'host', key: `h${e.seq}`, seq: e.seq, at: e.at, kind: e.kind, text });
  };
  const timeoutOf = (id: string): number | undefined => {
    const g = gate2.find((x) => x.id === id);
    return g?.createdAt === undefined ? undefined : Math.round((Date.parse(g.deadlineAt) - Date.parse(g.createdAt)) / 1000);
  };

  for (const e of events) {
    const d = e.data;
    const lane = str(d.agent) || e.stage;
    switch (e.kind) {
      case 'agent.tool': {
        if (isDelegation(e)) {
          const input = inputOf(e);
          const thread: ThreadItem = {
            type: 'thread',
            key: `d${e.seq}`,
            seq: e.seq,
            at: e.at,
            from: lane,
            to: subagentOf(e),
            task: str(input.prompt) || str(input.description),
            toolUseId: str(d.toolUseId) || null,
            replied: false,
            children: [],
          };
          // Threads stay top level: only the planner delegates in this runner.
          items.push(thread);
          threads.push(thread);
          turnOf.delete(thread.to);
        } else {
          turnFor(lane, e).tools.push(toolChip(str(d.tool), inputOf(e)));
        }
        break;
      }
      case 'agent.message': {
        const turn: TurnItem = { type: 'turn', key: `t${e.seq}`, seq: e.seq, at: e.at, agent: lane, text: str(d.text), reply: false, isError: false, calls: [], tools: [] };
        push(lane, turn);
        turnOf.set(lane, turn);
        break;
      }
      case 'agent.reply': {
        const id = str(d.toolUseId);
        const thread =
          (id === '' ? undefined : threads.find((t) => t.toolUseId === id)) ?? threads.find((t) => t.to === lane && !t.replied);
        const text = str(d.text);
        if (thread !== undefined) thread.replied = true;
        const last = (thread?.children ?? items).findLast((c): c is TurnItem => c.type === 'turn' && c.agent === lane);
        if (last !== undefined && sameText(last.text, text)) {
          last.reply = true;
          last.isError = d.isError === true;
        } else {
          const turn: TurnItem = { type: 'turn', key: `r${e.seq}`, seq: e.seq, at: e.at, agent: lane, text, reply: true, isError: d.isError === true, calls: [], tools: [] };
          (thread?.children ?? items).push(turn);
        }
        turnOf.delete(lane);
        break;
      }
      case 'http.sent':
      case 'policy.blocked': {
        if (lane === 'validator') lastValidator?.calls.push(callOf(e));
        else turnFor(lane, e).calls.push(callOf(e));
        break;
      }
      case 'candidate.submitted': {
        const v: ValidatorItem = {
          type: 'validator',
          key: `v${e.seq}`,
          seq: e.seq,
          at: e.at,
          candidateId: str(d.candidateId),
          title: str(d.title),
          severity: str(d.severity),
          replays: 0,
          matched: 0,
          control: null,
          verdict: 'proving',
          reason: null,
          autoReleased: false,
          findingId: null,
          calls: [],
        };
        validators.set(v.candidateId, v);
        lastValidator = v;
        push(lane, v);
        break;
      }
      case 'validator.replay': {
        const v = validators.get(str(d.candidateId));
        if (v !== undefined) {
          v.replays = Math.max(v.replays, num(d.n));
          if (d.matched === true) v.matched += 1;
        }
        break;
      }
      case 'validator.control': {
        const v = validators.get(str(d.candidateId));
        if (v !== undefined) v.control = { status: num(d.status), matched: d.matched === true };
        break;
      }
      case 'finding.confirmed':
      case 'finding.suspected':
      case 'finding.not_confirmed':
      case 'finding.released': {
        const cid = str(d.candidateId) || (findingToCandidate.get(str(d.findingId)) ?? '');
        const v = validators.get(cid);
        if (v === undefined) break;
        if (str(d.findingId) !== '') {
          v.findingId = str(d.findingId);
          findingToCandidate.set(v.findingId, cid);
        }
        if (e.kind === 'finding.confirmed') v.verdict = 'proven';
        else if (e.kind === 'finding.released') v.autoReleased = d.auto === true;
        else {
          v.verdict = 'not_proven';
          v.reason = str(d.reason) || null;
        }
        break;
      }
      case 'gate2.requested': {
        const g: Gate2Item = {
          type: 'gate2',
          key: `g${e.seq}`,
          seq: e.seq,
          at: e.at,
          gate2Id: str(d.gate2Id),
          agent: lane,
          method: str(d.method).toUpperCase(),
          url: str(d.url),
          body: str(d.body),
          asRole: str(d.asRole) || null,
          decided: null,
        };
        gate2Items.set(g.gate2Id, g);
        push(lane, g);
        break;
      }
      case 'gate2.decided': {
        const id = str(d.gate2Id);
        const g = gate2Items.get(id);
        const line = hostLine(e, { request: g === undefined ? undefined : { method: g.method, url: g.url }, gate2TimeoutS: timeoutOf(id) });
        if (g !== undefined) g.decided = line;
        else host(e, line);
        break;
      }
      default:
        host(e, hostLine(e));
    }
  }
  return items;
}

/** Only one agent's part of the conversation (a team-map node was clicked). */
export function filterConversation(items: readonly ConversationItem[], agent: string): ConversationItem[] {
  if (agent === 'validator') {
    const out: ConversationItem[] = [];
    for (const item of items) {
      if (item.type === 'validator') out.push(item);
      else if (item.type === 'thread') out.push(...item.children.filter((c) => c.type === 'validator'));
    }
    return out;
  }
  if (agent === 'orchestrator')
    return items.flatMap((item): ConversationItem[] => {
      if (item.type === 'thread') return [{ ...item, children: item.children.filter((c) => c.type === 'turn' && c.reply) }];
      return item.type === 'turn' && item.agent === 'orchestrator' ? [item] : [];
    });
  return items.filter((item) => (item.type === 'thread' ? item.to === agent : item.type !== 'host' && 'agent' in item && item.agent === agent));
}

interface Delegation {
  readonly to: string;
  readonly toolUseId: string;
  replied: boolean;
}

function delegations(events: readonly RunEvent[]): Delegation[] {
  const list: Delegation[] = [];
  for (const e of events) {
    if (isDelegation(e)) list.push({ to: subagentOf(e), toolUseId: str(e.data.toolUseId), replied: false });
    else if (e.kind === 'agent.reply') {
      const id = str(e.data.toolUseId);
      const lane = str(e.data.agent);
      const match = (id === '' ? undefined : list.find((x) => x.toolUseId === id)) ?? list.find((x) => x.to === lane && !x.replied);
      if (match !== undefined) match.replied = true;
    }
  }
  return list;
}

export type StageState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface Stage {
  readonly key: 'approved' | 'mapping' | 'planning' | 'testing' | 'proving' | 'review';
  readonly label: string;
  readonly detail: string;
  readonly state: StageState;
}

const CORE_LANES = new Set(['orchestrator', 'recon', 'validator']);

/**
 * The stage spine (spec §5.2 item 2). Several stages can be busy at once; the latest one with activity is current, the
 * reached ones before it are done, unreached ones before it were skipped. A finished run is at "Your review".
 */
export function stages(
  events: readonly RunEvent[],
  opts: { readonly terminal: boolean; readonly approvedBy: string | null },
): Stage[] {
  const recon = events.filter((e) => e.kind === 'http.sent' && str(e.data.agent) === 'recon').length;
  const reconTasks = delegations(events).filter((x) => x.to === 'recon').length;
  const planTotal = num(events.findLast((e) => e.kind === 'plan.cases')?.data.total);
  const plan = testCases(events);
  const cands = candidates(events);
  const proven = cands.filter((c) => c.status === 'confirmed' || c.status === 'released').length;
  const tested = events.some(
    (e) =>
      (e.kind === 'http.sent' || isDelegation(e) || e.kind === 'agent.message') &&
      !CORE_LANES.has(isDelegation(e) ? subagentOf(e) : str(e.data.agent)),
  ) || plan.counts.executing + plan.counts.executed > 0;
  const reached = [true, reconTasks > 0 || recon > 0, planTotal > 0 || plan.total > 0, tested, cands.length > 0, opts.terminal];
  const current = reached.lastIndexOf(true);
  // A stage before the current one keeps its present-tense label while its work is still open.
  const open = plan.counts.executing + plan.counts.proposed;
  const finished = [
    true,
    opts.terminal || reached[2] === true || (reconTasks > 0 && delegations(events).every((x) => x.to !== 'recon' || x.replied)),
    reached[2] === true,
    opts.terminal || (plan.total > 0 && open === 0),
    opts.terminal || (cands.length > 0 && cands.every((c) => c.status !== 'validating')),
    opts.terminal,
  ];
  const rows: { key: Stage['key']; now: string; past: string; detail: string }[] = [
    { key: 'approved', now: 'Approved', past: 'Approved', detail: opts.approvedBy === null ? '' : `by ${opts.approvedBy}` },
    { key: 'mapping', now: 'Mapping', past: 'Mapped', detail: reached[1] ? plural(recon, 'request', 'requests') : '' },
    { key: 'planning', now: 'Planning', past: 'Planned', detail: reached[2] ? plural(Math.max(planTotal, plan.total), 'test case', 'test cases') : '' },
    {
      key: 'testing',
      now: 'Testing',
      past: 'Tested',
      detail: plan.total > 0 ? `${plan.counts.executed.toLocaleString('en-US')} of ${plan.total.toLocaleString('en-US')} done` : '',
    },
    {
      key: 'proving',
      now: 'Proving',
      past: 'Proved',
      detail: cands.length === 0 ? '' : `${plural(cands.length, 'candidate', 'candidates')}${proven > 0 ? `, ${proven} proven` : ''}`,
    },
    { key: 'review', now: 'Your review', past: 'Your review', detail: '' },
  ];
  return rows.map((r, i) => {
    const state: StageState = i === current ? 'current' : i > current ? 'upcoming' : reached[i] ? 'done' : 'skipped';
    return { key: r.key, label: state === 'done' && finished[i] === true ? r.past : r.now, detail: state === 'skipped' ? 'skipped' : r.detail, state };
  });
}

export type NodeState = 'working' | 'waiting' | 'done' | 'idle';

export interface TeamNode {
  readonly id: string;
  readonly name: string;
  readonly state: NodeState;
  /** Working and spoke within SPIN_WINDOW_MS. */
  readonly spinning: boolean;
  /** The last real action, in words. */
  readonly sub: string;
}

export interface Team {
  readonly planner: TeamNode | null;
  readonly specialists: readonly TeamNode[];
  readonly validator: TeamNode | null;
  readonly tasks: number;
  readonly candidates: number;
  readonly proven: number;
}

/** A Gate 2 request still waiting for a person (pending and before its deadline; before mount `nowMs` is 0). */
export const isOpenGate2 = (g: Gate2, nowMs: number): boolean =>
  g.status === 'pending' && (nowMs === 0 || Date.parse(g.deadlineAt) > nowMs);

/**
 * Claude's team map (spec §5.2 item 3): only agents in the `run.started` manifest are drawn. Waiting beats working: a
 * pending Gate 2 for the agent makes it gold. Done means every delegation to it has a reply (or the run is over).
 */
export function teamNodes(events: readonly RunEvent[], gate2: readonly Gate2[], nowMs: number, terminal: boolean): Team {
  const agents = manifest(events);
  const tasks = delegations(events);
  const cands = candidates(events);
  const proven = cands.filter((c) => c.status === 'confirmed' || c.status === 'released').length;
  const waiting = new Set(gate2.filter((g) => isOpenGate2(g, nowMs)).map((g) => g.agent));
  const lastAt = (id: string): number => {
    const e = events.findLast((x) => (str(x.data.agent) || x.stage) === id);
    return e === undefined ? 0 : Date.parse(e.at);
  };
  const spins = (id: string): boolean => nowMs > 0 && nowMs - lastAt(id) < SPIN_WINDOW_MS;
  const node = (id: string, state: NodeState, sub: string): TeamNode => ({
    id,
    name: agentName(id),
    state,
    spinning: state === 'working' && spins(id),
    sub,
  });
  const started = agents.length > 0;

  const planner = agents.includes('orchestrator')
    ? node(
        'orchestrator',
        waiting.has('orchestrator') ? 'waiting' : terminal ? 'done' : started ? 'working' : 'idle',
        waiting.has('orchestrator') ? 'waiting on you' : tasks.length === 0 ? 'reading the plan' : `${plural(tasks.length, 'task', 'tasks')} given`,
      )
    : null;

  const specialists = agents
    .filter((id) => id !== 'orchestrator' && id !== 'validator')
    .map((id) => {
      const mine = tasks.filter((t) => t.to === id);
      const calls = events.filter((e) => e.kind === 'http.sent' && str(e.data.agent) === id);
      const lastPath = calls.length === 0 ? null : pathOf(str(calls.at(-1)?.data.url)).split('?')[0] ?? null;
      const open = mine.some((t) => !t.replied);
      if (waiting.has(id)) return node(id, 'waiting', 'waiting on you');
      if (open && !terminal) return node(id, 'working', lastPath === null ? 'task received' : `${id === 'recon' ? 'mapping' : 'testing'} ${lastPath}`);
      if (mine.length > 0 || calls.length > 0)
        return node(id, 'done', `${id === 'recon' ? 'mapped' : 'done'}, ${plural(calls.length, 'request', 'requests')}`);
      return node(id, 'idle', 'no task yet');
    });

  const proving = cands.filter((c) => c.status === 'validating');
  const validator = agents.includes('validator')
    ? proving.length > 0 && !terminal
      ? node('validator', 'working', `replay ${Math.min(proving.at(-1)?.replays ?? 0, VALIDATOR_REPLAYS)} of ${VALIDATOR_REPLAYS}`)
      : cands.length > 0
        ? node('validator', 'done', `${proven} of ${cands.length} proven`)
        : node('validator', 'idle', 'nothing to prove yet')
    : null;

  return { planner, specialists, validator, tasks: tasks.length, candidates: cands.length, proven };
}

/** Header liveness (spec §5.2 item 1): live, quiet after 15 s, reconnecting after a failed poll. */
export function liveness(
  nowMs: number,
  lastEventMs: number,
  failedSinceMs: number | null,
  lastOkMs: number,
): { readonly tone: 'live' | 'quiet' | 'reconnecting'; readonly text: string } {
  const ago = (ms: number): string => {
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  };
  if (failedSinceMs !== null) return { tone: 'reconnecting', text: `Reconnecting… last update ${ago(lastOkMs)} ago` };
  if (nowMs - lastEventMs < QUIET_AFTER_MS) return { tone: 'live', text: `Live · last event ${ago(lastEventMs)} ago` };
  return { tone: 'quiet', text: `Quiet for ${ago(lastEventMs)}` };
}

/** GET /runs/:id/exchanges: the recorded requests and responses (bodies are excerpts, credentials redacted). */
export const exchangeListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      agent: z.string(),
      method: z.string(),
      url: z.string(),
      requestHeaders: z.record(z.string(), z.string()).nullable().default(null),
      requestBody: z.string().nullable().default(null),
      status: z.number().nullable().default(null),
      responseHeaders: z.record(z.string(), z.string()).nullable().default(null),
      responseBody: z.string().nullable().default(null),
      durationMs: z.number().nullable().default(null),
      outcome: z.string(),
      reason: z.string().nullable().default(null),
      at: z.string(),
    }),
  ),
  lastSeq: z.number(),
});
export type Exchange = z.infer<typeof exchangeListSchema>['items'][number];
