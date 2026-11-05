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
        text: `Run killed by ${str(d.by)}`,
        meta: `${num(d.haltMs)} ms`,
        isError: true,
      };
    case 'run.queued':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed':
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
    return {
      name,
      turns: num(turn?.data.turns),
      costUsd: num(turn?.data.costUsd),
      task: str(message?.data.text),
      marks,
    };
  });
}

export interface Candidate {
  readonly candidateId: string;
  readonly title: string;
  readonly severity: string;
  readonly status: 'confirmed' | 'validating' | 'not_confirmed';
  readonly replays: number;
  readonly findingId: string | null;
}

/** Candidate findings come from validator events, so unconfirmed ones show too. */
export function candidates(events: readonly DemoRunEvent[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const e of events) {
    const id = str(e.data.candidateId);
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
    } else if (prev && (e.kind === 'finding.confirmed' || e.kind === 'finding.not_confirmed')) {
      byId.set(id, {
        ...prev,
        status: e.kind === 'finding.confirmed' ? 'confirmed' : 'not_confirmed',
        findingId: str(e.data.findingId) || null,
      });
    }
  }
  return [...byId.values()];
}
