/* Presentational values (window sizes, truncation) come from design/ and are not domain constants. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
// Pure functions that turn the run DTO and its events (docs/poc/AI_HUNT_POC.md section 2) into what the run screens
// draw. No React here, so the rules (kill confirmation, countdown, lane marks) are unit tested.
import type { DemoRunEvent } from '../../app/demo/_lib/schemas';

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);
export const DEFAULT_AGENTS = [
  'orchestrator',
  'recon',
  'web-api-specialist',
  'authz-specialist',
  'validator',
] as const;
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

/** Seconds until a Gate 2 deadline. Zero means the decision window is over: no decision is a denial. */
export function secondsLeft(deadlineAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - nowMs) / 1000));
}

/** Merge polled events into the list: unique by seq, ascending. Overlapping polls can return the same rows. */
export function mergeEvents(
  prev: readonly DemoRunEvent[],
  next: readonly DemoRunEvent[],
): DemoRunEvent[] {
  const bySeq = new Map<number, DemoRunEvent>();
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
export type ActivityKind =
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
export function describe(e: DemoRunEvent): Activity | null {
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

/** Lanes are the agents named by `run.started` (or the default team), with the latest turn totals and message. */
export function agentLanes(events: readonly DemoRunEvent[]): AgentLane[] {
  const started = events.find((e) => e.kind === 'run.started');
  const named = Array.isArray(started?.data.agents)
    ? (started.data.agents as unknown[]).map((a) => str(a))
    : [];
  const names = named.length > 0 ? named : [...DEFAULT_AGENTS];
  return names.map((name) => {
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
export function candidates(events: readonly DemoRunEvent[]): Candidate[] {
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
    } else if (prev && CANDIDATE_STATUS[e.kind] !== undefined) {
      byId.set(id, {
        ...prev,
        status: CANDIDATE_STATUS[e.kind],
        findingId: findingId ?? prev.findingId,
      });
    }
  }
  return [...byId.values()];
}

export const CASE_STATUSES = ['executed', 'executing', 'proposed', 'skipped', 'blocked'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** The test plan: every case starts proposed, `case.status` events move it. */
export function testCases(events: readonly DemoRunEvent[]): {
  total: number;
  counts: Record<CaseStatus, number>;
} {
  const byId = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'plan.cases' && Array.isArray(e.data.cases)) {
      for (const c of e.data.cases as { id?: unknown }[]) {
        const id = str(c.id);
        if (id !== '' && !byId.has(id)) byId.set(id, 'proposed');
      }
    } else if (e.kind === 'case.status') byId.set(str(e.data.caseId), str(e.data.status));
  }
  const counts = { executed: 0, executing: 0, proposed: 0, skipped: 0, blocked: 0 };
  for (const status of byId.values()) if (status in counts) counts[status as CaseStatus] += 1;
  return { total: byId.size, counts };
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
