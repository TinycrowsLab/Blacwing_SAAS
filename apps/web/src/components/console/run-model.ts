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
/** UUIDv7 ids start with their timestamp, so the random tail tells runs made in the same minute apart (as the API). */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(-8).toUpperCase(); // 8 characters, as the API
}

export function killConfirmed(typed: string, runId: string): boolean {
  return typed.trim().toLowerCase() === shortId(runId).toLowerCase();
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

/** A response size as the activity table shows it: `512 B`, `2.0 KB`. */
const byteSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

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
        meta: `${status}, ${byteSize(num(d.bytes))}`,
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

/** A stretch of a lane's time that waited: a Gate 2 ask until its decision, or the whole run while it was paused. */
export interface LaneWait {
  readonly from: number;
  /** Null while it still waits. */
  readonly to: number | null;
  readonly title: string;
  /** The agent stops for it (a pause, or an ask the runner waits on); a non-blocking ask lets the agent carry on. */
  readonly holds: boolean;
}

export interface AgentLane {
  readonly name: string;
  readonly turns: number;
  readonly costUsd: number;
  readonly task: string;
  /** The lane's latest request as the runner recorded it ("GET /x"), for a lane that has not spoken yet. */
  readonly last: string;
  /** The validator is code, not a model: no turns or cost. */
  readonly deterministic: boolean;
  readonly marks: readonly {
    readonly seq: number;
    readonly at: number;
    readonly shape: MarkShape;
    readonly title: string;
  }[];
  readonly waits: readonly LaneWait[];
}

/** The agents named by the `run.started` manifest, in its order. Empty until the run starts: nothing is guessed. */
export function manifest(events: readonly RunEvent[]): string[] {
  const started = events.find((e) => e.kind === 'run.started');
  return Array.isArray(started?.data.agents)
    ? (started.data.agents as unknown[]).map((a) => str(a)).filter((a) => a !== '')
    : [];
}

interface LaneAcc {
  turn?: RunEvent;
  message?: RunEvent;
  lastCall?: RunEvent;
  latestRow?: Activity;
  readonly marks: AgentLane['marks'][number][];
  readonly waits: LaneWait[];
}

/**
 * Lanes are the agents named by `run.started`, with the latest turn totals and message, every marked event and every
 * wait (a Gate 2 ask from `gate2.requested` to its `gate2.decided`; a run pause on every lane). One pass over the
 * events, so a run with thousands of them stays cheap on every poll.
 */
export function agentLanes(events: readonly RunEvent[]): AgentLane[] {
  const names = manifest(events);
  const acc = new Map<string, LaneAcc>(names.map((n) => [n, { marks: [], waits: [] }]));
  const asks = new Map<string, { agent: string; wait: LaneWait }>();
  const pauses: LaneWait[] = [];
  for (const e of events) {
    const row = describe(e);
    const at = Date.parse(e.at);
    const owner = acc.get(str(e.data.agent) || e.stage);
    if (owner !== undefined) {
      if (e.kind === 'agent.turn') owner.turn = e;
      else if (e.kind === 'agent.message' || e.kind === 'agent.reply') owner.message = e;
      else if (e.kind === 'http.sent') owner.lastCall = e;
      if (row?.mark) owner.marks.push({ seq: e.seq, at, shape: row.mark, title: row.text });
    }
    // The validator's latest word is its latest row, whatever lane the event was filed under.
    const rowOwner = row === null ? undefined : acc.get(row.agent);
    if (rowOwner !== undefined && row !== null) rowOwner.latestRow = row;
    const gate2Id = str(e.data.gate2Id);
    if (e.kind === 'gate2.requested' && acc.has(str(e.data.agent))) {
      const title = `Waiting for your decision on ${str(e.data.method)} ${pathOf(str(e.data.url))}`;
      asks.set(gate2Id, { agent: str(e.data.agent), wait: { from: at, to: null, title, holds: e.data.blocking !== false } });
    } else if (e.kind === 'gate2.decided') {
      const ask = asks.get(gate2Id);
      asks.delete(gate2Id);
      if (ask !== undefined) acc.get(ask.agent)?.waits.push({ ...ask.wait, to: at });
    } else if (e.kind === 'run.paused' && pauses.at(-1)?.to !== null) {
      pauses.push({ from: at, to: null, title: 'Run paused', holds: true });
    } else if (e.kind === 'run.resumed') {
      const open = pauses.at(-1);
      if (open?.to === null) pauses[pauses.length - 1] = { ...open, to: at };
    }
  }
  for (const { agent, wait } of asks.values()) acc.get(agent)?.waits.push(wait);
  return names.map((name) => {
    const a = acc.get(name) ?? { marks: [], waits: [] };
    const deterministic = name === 'validator';
    return {
      name,
      turns: num(a.turn?.data.turns),
      costUsd: num(a.turn?.data.costUsd),
      task: deterministic ? (a.latestRow?.text ?? '') : str(a.message?.data.text),
      last: a.lastCall === undefined ? '' : (describe(a.lastCall)?.text ?? ''),
      deterministic,
      marks: a.marks,
      waits: [...a.waits, ...pauses].sort((x, y) => x.from - y.from),
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
  /** The validator confirmed it (a `finding.confirmed` event): stays true whatever a person decides at Gate 3. */
  readonly proven: boolean;
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
        proven: false,
      });
    } else if (prev && e.kind === 'validator.replay') {
      byId.set(id, { ...prev, replays: Math.max(prev.replays, num(e.data.n)) });
    } else if (prev && status !== undefined) {
      byId.set(id, {
        ...prev,
        status,
        findingId: findingId ?? prev.findingId,
        proven: prev.proven || e.kind === 'finding.confirmed',
      });
    }
  }
  return [...byId.values()];
}

export type CaseStatus = 'executed' | 'executing' | 'proposed' | 'skipped' | 'blocked' | 'model_declined';

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
    } else if (e.kind === 'coverage.summary' && Array.isArray(e.data.cases)) {
      // The runner's final word on each case (derived from what was actually sent), so every count agrees with it.
      for (const c of e.data.cases as Record<string, unknown>[]) {
        const id = str(c.id);
        const prev = byId.get(id) ?? { id, title: str(c.title), agent: str(c.agent), target: '', status: 'proposed', note: '' };
        const status = str(c.status);
        byId.set(id, { ...prev, status: status === 'not_run' ? 'proposed' : status, note: str(c.note) || prev.note });
      }
    }
  }
  return [...byId.values()];
}

export function testCases(events: readonly RunEvent[]): {
  total: number;
  counts: Record<CaseStatus, number>;
} {
  const list = caseList(events);
  const counts = { executed: 0, executing: 0, proposed: 0, skipped: 0, blocked: 0, model_declined: 0 };
  for (const c of list) if (c.status in counts) counts[c.status as CaseStatus] += 1;
  return { total: list.length, counts };
}

/**
 * How far the test plan got, for the finish line: the runner's own `coverage.summary` when it sent one, else the
 * case statuses the agents recorded.
 */
export function caseTally(events: readonly RunEvent[]): { executed: number; skipped: number; total: number } {
  const plan = testCases(events);
  return { executed: plan.counts.executed, skipped: plan.counts.skipped, total: plan.total };
}

/** Requests sent as each test-account role (`http.sent.asRole`), for "Account use". */
export function accountUse(events: readonly RunEvent[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const e of events) {
    const role = e.kind === 'http.sent' ? str(e.data.asRole) : '';
    if (role !== '') used.set(role, (used.get(role) ?? 0) + 1);
  }
  return used;
}

/**
 * The open asks that hold their agent: every ask from a runner that waits on the decision. An ask whose
 * `gate2.requested` says `blocking: false` lets the agent carry on with other cases, so it never marks it waiting.
 */
export function blockingAsks(events: readonly RunEvent[], open: readonly Gate2[]): Gate2[] {
  const free = new Set(
    events.filter((e) => e.kind === 'gate2.requested' && e.data.blocking === false).map((e) => str(e.data.gate2Id)),
  );
  return open.filter((g) => !free.has(g.id));
}

/** The one line shown after a gated decision: the ledger event id and a shortened hash. */
/** UUIDv7 ids start with their timestamp, so the random tail tells ledger events apart. */
function auditEventLabel(eventId: string): string {
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
const SPIN_WINDOW_MS = 10_000;
/** Liveness turns to "Quiet" after this long without an event. */
const QUIET_AFTER_MS = 15_000;

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
  gate2_denied: 'you denied this request earlier',
  gate2_expired: 'an earlier ask got no answer in time',
  private_address: 'a private or local network address',
  invalid_path: 'the path has control characters',
};

/** A `policy.blocked` rule in words; an unknown rule shows as itself. */
export const ruleWords = (rule: string): string => RULE_WORDS[rule] ?? rule.replace(/_/g, ' ');

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const CASE_UPDATE: Readonly<Record<string, string>> = {
  executing: 'started a test case',
  executed: 'finished a test case',
  skipped: 'skipped a test case',
  blocked: 'marked a test case blocked',
};

/** A non-delegation tool call as a short chip under the turn that made it (words, never raw case ids). */
function toolChip(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'record_test_cases':
      return `recorded ${plural(Array.isArray(input.cases) ? input.cases.length : 0, 'test case', 'test cases')}`;
    case 'update_test_case':
      return CASE_UPDATE[str(input.status)] ?? 'updated a test case';
    case 'submit_candidate':
      return str(input.title) === '' ? 'submitted a candidate' : `submitted a candidate: ${str(input.title)}`;
    case 'list_exchanges':
      return 'looked back at earlier requests';
    case 'await_decision':
      return 'waited for your decision';
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

interface Gate2Item {
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
  /** The runner does not wait on this ask (`blocking: false`): its later use is tracked through `http.sent.gate2Id`. */
  readonly nonBlocking: boolean;
  /** When the allowed request went out (the first `http.sent` that used this approval). */
  sentAt: string | null;
  runEnded: boolean;
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
  /** The key of the delegation this segment belongs to (its own key for the first segment). */
  readonly root: string;
  /** A later segment of the same delegation: it resumes below items that happened in between, so time reads down. */
  readonly continued: boolean;
  replied: boolean;
  readonly children: ThreadChild[];
}

export type ConversationItem = ThreadItem | ThreadChild;

/** Delegations opened this close together are one fan-out: a sibling's first steps may sit above the next one. */
const FANOUT_MS = 5000;

/** Repeated identical chips fold into one: "marked 3 test cases blocked", else "used X ×3". */
export function chipGroups(tools: readonly string[]): string[] {
  const out: { text: string; n: number }[] = [];
  for (const t of tools) {
    const last = out.at(-1);
    if (last?.text === t) last.n += 1;
    else out.push({ text: t, n: 1 });
  }
  return out.map(({ text, n }) =>
    n === 1 ? text : text.includes('a test case') ? text.replace('a test case', `${n} test cases`) : `${text} ×${n}`,
  );
}

const isDelegation = (e: RunEvent): boolean => e.kind === 'agent.tool' && (str(e.data.tool) === 'Agent' || str(e.data.tool) === 'Task');
const inputOf = (e: RunEvent): Record<string, unknown> =>
  typeof e.data.input === 'object' && e.data.input !== null ? (e.data.input as Record<string, unknown>) : {};
const subagentOf = (e: RunEvent): string => str(inputOf(e).subagent) || 'general-purpose';
/**
 * The reply repeats the specialist's last turn: the same words, or one is the start of the other (the runner clips a
 * reply at 4,000 characters, and a tool result may add a trailer). Returns the longer text, or null when they differ.
 */
const sameText = (a: string | null, b: string): string | null => {
  if (a === null) return null;
  const x = a.trim();
  const y = b.trim();
  if (x === '' || y === '') return x === y ? x : null;
  return x.startsWith(y) ? a : y.startsWith(x) ? b : null;
};

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
 * own lines come only from the host-line catalogue. Time reads down: when something else happened after a thread
 * (another agent spoke, the planner moved on), the thread resumes in a `continued` segment at the bottom instead of
 * growing above it. Sibling delegations of one fan-out do not split each other.
 * shortcut: calls attach to the lane's latest turn wherever it is drawn, so a burst of requests never shreds the
 * conversation into one-row segments; upgrade when http.sent carries the toolUseId.
 */
export function conversationItems(
  events: readonly RunEvent[],
  gate2: readonly Gate2[],
  viewerName: string | null = null,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const threads: ThreadItem[] = [];
  const turnOf = new Map<string, TurnItem>();
  const validators = new Map<string, ValidatorItem>();
  const findingToCandidate = new Map<string, string>();
  const gate2Items = new Map<string, Gate2Item>();
  let lastValidator: ValidatorItem | null = null;

  const openThread = (lane: string): ThreadItem | undefined =>
    threads.findLast((t) => t.to === lane && !t.replied) ?? threads.findLast((t) => t.to === lane);
  /** The segment a new child of `thread` goes into: its newest one while nothing else came after it, else a new one. */
  const segmentOf = (thread: ThreadItem, item: ThreadChild): ThreadItem => {
    const seg = threads.findLast((t) => t.root === thread.root) ?? thread;
    const after = items.slice(items.lastIndexOf(seg) + 1);
    const free = after.every(
      (x) => x.type === 'thread' && !x.continued && x.children.length === 0 && Date.parse(x.at) - Date.parse(seg.at) <= FANOUT_MS,
    );
    if (free) return seg;
    const next: ThreadItem = { ...seg, key: `${seg.root}-${item.key}`, seq: item.seq, at: item.at, continued: true, children: [] };
    items.push(next);
    threads.push(next);
    return next;
  };
  const appendTo = (thread: ThreadItem | undefined, item: ThreadChild): void => {
    if (thread === undefined) items.push(item);
    else segmentOf(thread, item).children.push(item);
  };
  const push = (lane: string, item: ThreadChild): void => {
    appendTo(lane === 'orchestrator' ? undefined : openThread(lane), item);
  };
  /** The turn a chip or call joins. The planner's turns are top level: one with later items below it is closed. */
  const turnFor = (lane: string, e: RunEvent): TurnItem => {
    const existing = turnOf.get(lane);
    if (existing !== undefined && (lane !== 'orchestrator' || items.at(-1) === existing)) return existing;
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
            root: `d${e.seq}`,
            continued: false,
            replied: false,
            children: [],
          };
          // Threads stay top level: only the planner delegates in this runner.
          items.push(thread);
          threads.push(thread);
          turnOf.delete(thread.to);
        } else if (str(d.tool) !== 'record_test_cases') {
          // Recording the plan has its own Blackwing line (plan.cases) at the moment it landed: no second chip.
          turnFor(lane, e).tools.push(toolChip(str(d.tool), inputOf(e)));
        }
        break;
      }
      case 'agent.message': {
        const turn: TurnItem = { type: 'turn', key: `t${e.seq}`, seq: e.seq, at: e.at, agent: lane, text: str(d.text), reply: false, isError: false, calls: [], tools: [] };
        if (lane === 'orchestrator') {
          // The planner narrates the delegations it just made ("I started recon, waiting for its results"): that note
          // reads before those threads while nothing happened in them yet.
          let at = items.length;
          while (at > 0) {
            const prev = items[at - 1];
            if (prev?.type !== 'thread' || prev.from !== 'orchestrator' || prev.replied || prev.continued || prev.children.length > 0) break;
            at -= 1;
          }
          items.splice(at, 0, turn);
        } else push(lane, turn);
        turnOf.set(lane, turn);
        break;
      }
      case 'agent.reply': {
        const id = str(d.toolUseId);
        const thread =
          (id === '' ? undefined : threads.find((t) => t.toolUseId === id)) ?? threads.find((t) => t.to === lane && !t.replied);
        const text = str(d.text);
        const segments = thread === undefined ? [] : threads.filter((t) => t.root === thread.root);
        const last = (segments.length === 0 ? items : segments.flatMap((t) => t.children)).findLast(
          (c): c is TurnItem => c.type === 'turn' && c.agent === lane,
        );
        const same = last === undefined ? null : sameText(last.text, text);
        if (last !== undefined && same !== null) {
          last.text = same;
          last.reply = true;
          last.isError = d.isError === true;
        } else {
          appendTo(thread, { type: 'turn', key: `r${e.seq}`, seq: e.seq, at: e.at, agent: lane, text, reply: true, isError: d.isError === true, calls: [], tools: [] });
        }
        for (const t of thread === undefined ? [] : threads.filter((x) => x.root === thread.root)) t.replied = true;
        turnOf.delete(lane);
        break;
      }
      case 'http.sent':
      case 'policy.blocked': {
        const used = e.kind === 'http.sent' ? gate2Items.get(str(d.gate2Id)) : undefined;
        if (used !== undefined) used.sentAt ??= e.at;
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
          nonBlocking: d.blocking === false,
          sentAt: null,
          runEnded: false,
        };
        gate2Items.set(g.gate2Id, g);
        push(lane, g);
        // A call sent after the decision reads after its receipt, not above the question.
        turnOf.delete(lane);
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
        host(e, hostLine(e, { viewerName, cases: e.kind === 'run.completed' ? caseTally(events) : null }));
    }
  }
  const ended = events.some((e) => e.kind === 'run.completed' || e.kind === 'run.killed' || e.kind === 'run.failed');
  for (const g of gate2Items.values()) g.runEnded = ended;
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
      if (item.type === 'thread') {
        const children = item.children.filter((c) => c.type === 'turn' && c.reply);
        return item.continued && children.length === 0 ? [] : [{ ...item, children }];
      }
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
    // The plan is built from recon's map: once it is recorded, recon's earlier tasks are over (the spine says
    // "Mapped" at the same moment), even when the runner recorded no reply.
    else if (e.kind === 'plan.cases') {
      for (const x of list) if (x.to === 'recon') x.replied = true;
    } else if (e.kind === 'agent.reply') {
      const id = str(e.data.toolUseId);
      const lane = str(e.data.agent);
      const match = (id === '' ? undefined : list.find((x) => x.toolUseId === id)) ?? list.find((x) => x.to === lane && !x.replied);
      if (match !== undefined) match.replied = true;
    }
  }
  return list;
}

/** `active`: still busy behind the current stage. `stopped`: the run ended before this stage's work did. */
type StageState = 'done' | 'current' | 'active' | 'stopped' | 'upcoming' | 'skipped';

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
  opts: { readonly terminal: boolean; readonly approvedBy: string | null; readonly stopped?: boolean },
): Stage[] {
  const recon = events.filter((e) => e.kind === 'http.sent' && str(e.data.agent) === 'recon').length;
  const reconTasks = delegations(events).filter((x) => x.to === 'recon').length;
  const planTotal = num(events.findLast((e) => e.kind === 'plan.cases')?.data.total);
  const plan = testCases(events);
  const cands = candidates(events);
  const proven = cands.filter((c) => c.proven).length;
  const tested = events.some(
    (e) =>
      (e.kind === 'http.sent' || isDelegation(e) || e.kind === 'agent.message') &&
      !CORE_LANES.has(isDelegation(e) ? subagentOf(e) : str(e.data.agent)),
  ) || plan.counts.executing + plan.counts.executed > 0;
  const reached = [true, reconTasks > 0 || recon > 0, planTotal > 0 || plan.total > 0, tested, cands.length > 0, opts.terminal];
  const current = reached.lastIndexOf(true);
  // A stage before the current one keeps its present-tense label while its work is still open.
  const open = plan.counts.executing + plan.counts.proposed;
  // A stage ticks only when its own work ended, never because a later stage started or the run was stopped.
  const finished = [
    true,
    reached[2] === true || (reconTasks > 0 && delegations(events).every((x) => x.to !== 'recon' || x.replied)),
    reached[2] === true,
    (plan.total > 0 && open === 0) || (opts.terminal && opts.stopped !== true && plan.total === 0),
    cands.length > 0 && cands.every((c) => c.status !== 'validating'),
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
  const lastWork = reached.slice(0, -1).lastIndexOf(true);
  return rows.map((r, i) => {
    const state: StageState =
      i === current
        ? 'current'
        : i > current
          ? 'upcoming'
          : !reached[i]
            ? 'skipped'
            : finished[i] === true
              ? 'done'
              : opts.terminal
                ? 'stopped'
                : 'active';
    // A run that ended early never reached the stages after its last activity: "not reached", not "skipped".
    const missed = opts.terminal && i > lastWork ? 'not reached' : 'skipped';
    const detail =
      state === 'skipped'
        ? missed
        : state === 'stopped'
          ? r.key === 'testing' && plan.total > 0
            ? `${opts.stopped === true ? 'stopped at ' : ''}${plan.counts.executed.toLocaleString('en-US')} of ${plan.total.toLocaleString('en-US')}${opts.stopped === true ? '' : ' done'}`
            : `${opts.stopped === true ? 'stopped' : 'unfinished'}${r.detail === '' ? '' : ` · ${r.detail}`}`
          : r.detail;
    // Nothing was found: the run's end is not a gold "your turn". A finished run is done, a stopped one stopped.
    if (r.key === 'review' && opts.terminal && cands.length === 0)
      return { key: r.key, label: r.now, detail: 'nothing to review', state: opts.stopped === true ? 'stopped' : 'done' };
    return { key: r.key, label: state === 'done' ? r.past : r.now, detail, state };
  });
}

/** `stopped`: the run was stopped while this agent still had work open (never shown as done). */
type NodeState = 'working' | 'waiting' | 'done' | 'idle' | 'stopped';

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
  /** A proven issue was released without a person (the request chose automatic release). */
  readonly autoReleased: boolean;
}

/** A Gate 2 request still waiting for a person (pending and before its deadline; before mount `nowMs` is 0). */
export const isOpenGate2 = (g: Gate2, nowMs: number): boolean =>
  g.status === 'pending' && (nowMs === 0 || Date.parse(g.deadlineAt) > nowMs);

/**
 * Claude's team map (spec §5.2 item 3): only agents in the `run.started` manifest are drawn. Waiting beats working: a
 * pending Gate 2 for the agent makes it gold. Done means every delegation to it has a reply (or the run is over).
 */
export function teamNodes(
  events: readonly RunEvent[],
  gate2: readonly Gate2[],
  nowMs: number,
  terminal: boolean,
  /** The run was stopped (or failed) rather than finishing: open work reads "stopped", not "done". */
  stopped = false,
  /** Paused: nothing is sent, so no ring spins. */
  paused = false,
): Team {
  const agents = manifest(events);
  const tasks = delegations(events);
  const cands = candidates(events);
  const proven = cands.filter((c) => c.proven).length;
  const openAsks = gate2.filter((g) => isOpenGate2(g, nowMs));
  const blocking = new Set(blockingAsks(events, openAsks).map((g) => g.id));
  const waiting = new Set(openAsks.filter((g) => blocking.has(g.id)).map((g) => g.agent));
  // An ask that does not block: the agent carries on with other cases, and its line says it asked.
  const asked = new Set(openAsks.filter((g) => !blocking.has(g.id)).map((g) => g.agent));
  const askedNote = (id: string, sub: string): string => (asked.has(id) ? `asked you · ${sub}` : sub);
  const lastAt = (id: string): number => {
    const e = events.findLast((x) => (str(x.data.agent) || x.stage) === id);
    return e === undefined ? 0 : Date.parse(e.at);
  };
  const spins = (id: string): boolean => nowMs > 0 && nowMs - lastAt(id) < SPIN_WINDOW_MS;
  const node = (id: string, state: NodeState, sub: string): TeamNode => ({
    id,
    name: agentName(id),
    state,
    spinning: state === 'working' && !paused && spins(id),
    sub,
  });
  const started = agents.length > 0;

  // The plain sub-line; the state itself is the node's mark (and part of its accessible name).
  const planner = agents.includes('orchestrator')
    ? node(
        'orchestrator',
        waiting.has('orchestrator') ? 'waiting' : terminal ? (stopped ? 'stopped' : 'done') : started ? 'working' : 'idle',
        waiting.has('orchestrator')
          ? 'waiting on you'
          : askedNote(
              'orchestrator',
              tasks.length > 0 ? `${plural(tasks.length, 'task', 'tasks')} given` : terminal ? 'no tasks given' : 'reading the plan',
            ),
      )
    : null;

  const where = (path: string): string => (path === '/' ? 'the home page' : path);
  const specialists = agents
    .filter((id) => id !== 'orchestrator' && id !== 'validator')
    .map((id) => {
      const mine = tasks.filter((t) => t.to === id);
      const calls = events.filter((e) => e.kind === 'http.sent' && str(e.data.agent) === id);
      const lastPath = calls.length === 0 ? null : pathOf(str(calls.at(-1)?.data.url)).split('?')[0] ?? null;
      const open = mine.some((t) => !t.replied);
      const sent = plural(calls.length, 'request', 'requests');
      if (waiting.has(id)) return node(id, 'waiting', 'waiting on you');
      if (open && !terminal)
        return node(id, 'working', askedNote(id, lastPath === null ? 'task received' : `${id === 'recon' ? 'mapping' : 'testing'} ${where(lastPath)}`));
      if (open && stopped) return node(id, 'stopped', `stopped mid-task, ${sent}`);
      if (mine.length > 0 || calls.length > 0) return node(id, 'done', id === 'recon' ? `mapped, ${sent}` : `${open ? 'finished' : 'reported back'}, ${sent}`);
      return node(id, 'idle', 'no task yet');
    });

  const proving = cands.filter((c) => c.status === 'validating');
  const validator = agents.includes('validator')
    ? proving.length > 0 && terminal && stopped
      ? node('validator', 'stopped', `stopped while proving, ${proven} of ${cands.length} proven`)
      : proving.length > 0 && !terminal
      ? node('validator', 'working', `replay ${Math.min(proving.at(-1)?.replays ?? 0, VALIDATOR_REPLAYS)} of ${VALIDATOR_REPLAYS}`)
      : cands.length > 0
        ? node('validator', 'done', `${proven} of ${cands.length} proven`)
        : node('validator', 'idle', 'nothing to prove yet')
    : null;

  const autoReleased = events.some((e) => e.kind === 'finding.released' && e.data.auto === true);
  return { planner, specialists, validator, tasks: tasks.length, candidates: cands.length, proven, autoReleased };
}

/**
 * Header liveness (spec §5.2 item 1): three states only. Live while events arrive, quiet after 15 s without one (an open
 * decision does not change it: other agents may still be working), reconnecting after a failed poll. `short` is the
 * phone's one-word form.
 */
export function liveness(
  nowMs: number,
  lastEventMs: number,
  failedSinceMs: number | null,
  lastOkMs: number,
): { readonly tone: 'live' | 'quiet' | 'reconnecting'; readonly text: string; readonly short: string } {
  const ago = (ms: number): string => {
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
  };
  if (failedSinceMs !== null) return { tone: 'reconnecting', text: `Reconnecting… last update ${ago(lastOkMs)} ago`, short: 'Reconnecting…' };
  if (nowMs - lastEventMs < QUIET_AFTER_MS) return { tone: 'live', text: `Live · last event ${ago(lastEventMs)} ago`, short: 'Live' };
  return { tone: 'quiet', text: `Quiet for ${ago(lastEventMs)}`, short: `Quiet for ${ago(lastEventMs)}` };
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
