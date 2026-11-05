// Results model (experience spec §7): pure functions over the run DTO, the request and the ledger. Every number and
// sentence here is derived from what the runner and the API recorded; nothing is estimated.
import { z } from 'zod';

import { finishReason } from '../../../lib/host-lines';
import { findingSchema, type AssessmentRequest, type Run } from '../../../lib/schemas';

export type FindingSummary = Run['findings'][number];
type RunEvent = Run['events'][number];

/** GET /audit, keeping each event's whole payload (reasons, run ids, methods) for "Your decisions" and the ledger. */
export const ledgerSchema = z.object({
  items: z.array(
    z.object({
      eventId: z.string(),
      seq: z.number(),
      at: z.string(),
      actor: z.object({ id: z.string().nullable(), name: z.string() }),
      action: z.string(),
      targetType: z.string(),
      targetId: z.string(),
      payload: z.record(z.string(), z.unknown()).default({}),
      hash: z.string(),
    }),
  ),
  chain: z.object({ verified: z.boolean(), count: z.number(), brokenAtSeq: z.number().nullable() }),
});
export type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerItem = Ledger['items'][number];

/** A finding plus how its negative control behaved (`replay.control`), for "the control behaved as expected". */
export const findingDetailSchema = findingSchema.extend({
  replay: z
    .object({ control: z.object({ status: z.number(), matched: z.boolean() }).nullable().default(null) })
    .nullable()
    .default(null),
});
export type FindingDetail = z.infer<typeof findingDetailSchema>;

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const rank = (severity: string): number => {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Severity first, then the oldest first (the API has no confidence on summaries). */
export function bySeverity(a: FindingSummary, b: FindingSummary): number {
  return rank(a.severity) - rank(b.severity) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

/**
 * Proven = the validator confirmed it (a `finding.confirmed` event, or still `confirmed`). Everything else the run
 * recorded was suspected and kept back, whatever a person later decided about it.
 */
export function splitFindings(run: Pick<Run, 'events' | 'findings'>): {
  proven: FindingSummary[];
  kept: FindingSummary[];
} {
  const confirmed = new Set(
    run.events.filter((e) => e.kind === 'finding.confirmed').map((e) => str(e.data.findingId)),
  );
  const proven: FindingSummary[] = [];
  const kept: FindingSummary[] = [];
  for (const f of run.findings) (confirmed.has(f.id) || f.status === 'confirmed' ? proven : kept).push(f);
  return { proven: proven.sort(bySeverity), kept: kept.sort(bySeverity) };
}

/** Test cases from the plan events: the latest plan total and how many ended `executed`. */
export function testCases(events: readonly RunEvent[]): { executed: number; total: number } {
  const ids = new Set<string>();
  let total = 0;
  const latest = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'plan.cases') {
      if (Array.isArray(e.data.cases))
        for (const c of e.data.cases) {
          const id = typeof c === 'object' && c !== null ? str((c as { id?: unknown }).id) : null;
          if (id !== null) ids.add(id);
        }
      if (typeof e.data.total === 'number') total = Math.max(total, e.data.total);
    }
    if (e.kind === 'case.status') {
      const id = str(e.data.caseId);
      const status = str(e.data.status);
      if (id !== null && status !== null) latest.set(id, status);
    }
  }
  const executed = [...latest.values()].filter((s) => s === 'executed').length;
  return { executed, total: Math.max(total, ids.size, executed) };
}

const MS_PER_S = 1000;
const S_PER_MIN = 60;
const MIN_PER_H = 60;

/** "18m 12s", "45s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / MS_PER_S));
  const m = Math.floor(s / S_PER_MIN);
  if (m === 0) return `${s}s`;
  if (m < MIN_PER_H) return `${m}m ${String(s % S_PER_MIN).padStart(2, '0')}s`;
  return `${Math.floor(m / MIN_PER_H)}h ${String(m % MIN_PER_H).padStart(2, '0')}m`;
}

/** The eyebrow over the results headline: how long it ran and why it stopped, in words. */
export function stopLine(
  run: Pick<Run, 'state' | 'startedAt' | 'finishedAt' | 'createdAt' | 'events'>,
  now: number,
): { tone: 'ok' | 'muted' | 'bad'; text: string } {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  const took = duration(end - start);
  switch (run.state) {
    case 'completed': {
      const done = run.events.findLast((e) => e.kind === 'run.completed');
      return { tone: 'ok', text: `Finished in ${took} · ${finishReason(done?.data.reason)}` };
    }
    case 'killed':
      return { tone: 'muted', text: `Stopped after ${took} · you stopped testing` };
    case 'failed': {
      const failed = run.events.findLast((e) => e.kind === 'run.failed');
      const why = str(failed?.data.reason);
      return { tone: 'bad', text: `Stopped after ${took} · the run ended with an error${why === null ? '' : ` (${why})`}` };
    }
    default:
      return { tone: 'muted', text: `Still testing · ${took} so far. These are the results until now.` };
  }
}

/** "2 both denied", "1 allowed", "3: 1 allowed, 2 denied" for the report card's "Decisions asked". */
export function gate2Outcome(gate2: Run['gate2']): { asked: number; label: string } {
  const decided = gate2.filter((g) => g.status !== 'pending');
  const allowed = decided.filter((g) => g.status === 'approved').length;
  const denied = decided.length - allowed;
  const pending = gate2.length - decided.length;
  const parts: string[] = [];
  if (allowed > 0) parts.push(`${allowed} allowed`);
  if (denied > 0) parts.push(`${denied} denied`);
  if (pending > 0) parts.push(`${pending} open`);
  let label = parts.join(', ');
  if (parts.length === 1) {
    const word = label.replace(/^\d+ /, '');
    label = gate2.length === 1 ? word : gate2.length === 2 ? `both ${word}` : `all ${word}`;
  }
  return { asked: gate2.length, label: gate2.length === 0 ? 'none' : label };
}

export interface DecisionRow {
  readonly key: string;
  /** Approval, Request, Release, Dismissal, Stop. */
  readonly group: string;
  readonly verb: string;
  /** The thing decided on: a request line (mono) or a finding title (quoted). */
  readonly subject: { readonly text: string; readonly mono: boolean } | null;
  readonly detail: string | null;
  readonly reason: string | null;
  /** Who decided, when not the viewer (null for the viewer or for Blackwing itself). */
  readonly who: string | null;
  readonly at: string | null;
}

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/**
 * "Your decisions" for one run: Gate 1 (the request), Gate 2 (the run's decisions, with expiries), Gate 3 and stop
 * (the ledger), and automatic releases (run events). Oldest first.
 */
export function decisions(input: {
  readonly run: Pick<Run, 'id' | 'events' | 'findings' | 'gate2'>;
  readonly request: Pick<AssessmentRequest, 'id' | 'status' | 'approver' | 'decisionReason' | 'decidedAt'> | null;
  readonly ledger: readonly LedgerItem[];
  readonly viewerName: string;
  readonly gate2TimeoutS: number | null;
}): DecisionRow[] {
  const { run, request, ledger, viewerName } = input;
  const who = (name: string | null | undefined): string | null =>
    name === null || name === undefined || name === viewerName ? null : name;
  const title = (id: string): string => run.findings.find((f) => f.id === id)?.title ?? 'a finding';
  const rows: DecisionRow[] = [];

  if (request !== null && request.decidedAt !== null) {
    rows.push({
      key: `g1-${request.id}`,
      group: 'Approval',
      verb: request.status === 'rejected' ? 'Rejected the plan' : 'Approved the plan',
      subject: null,
      detail: null,
      reason: request.decisionReason,
      who: who(request.approver?.name),
      at: request.decidedAt,
    });
  }

  const roles = new Map<string, string>();
  for (const e of run.events)
    if (e.kind === 'gate2.requested') {
      const id = str(e.data.gate2Id);
      const role = str(e.data.asRole);
      if (id !== null && role !== null) roles.set(id, role);
    }
  for (const g of run.gate2) {
    if (g.status === 'pending') continue;
    const role = roles.get(g.id);
    const asRole = role === undefined ? null : `as ${role}`;
    const subject = { text: `${g.method.toUpperCase()} ${pathOf(g.url)}`, mono: true };
    const at = g.decidedAt ?? g.deadlineAt;
    if (g.status === 'approved') {
      rows.push({ key: g.id, group: 'Request', verb: 'Allowed', subject, detail: [asRole, 'for this run'].filter(Boolean).join(' '), reason: g.decisionReason, who: who(g.decidedBy), at });
    } else if (g.status === 'expired') {
      const total =
        input.gate2TimeoutS ??
        (g.createdAt === undefined ? null : (Date.parse(g.deadlineAt) - Date.parse(g.createdAt)) / MS_PER_S);
      const wait = total === null ? 'no answer in time' : `no answer in ${Math.max(1, Math.round(total / S_PER_MIN))} min`;
      rows.push({ key: g.id, group: 'Request', verb: 'Denied automatically', subject, detail: [asRole, wait].filter(Boolean).join(', '), reason: null, who: null, at });
    } else if (g.decidedBy === null) {
      rows.push({ key: g.id, group: 'Request', verb: 'Denied automatically', subject, detail: 'the audit was stopping', reason: null, who: null, at });
    } else {
      rows.push({ key: g.id, group: 'Request', verb: 'Denied', subject, detail: asRole, reason: g.decisionReason, who: who(g.decidedBy), at });
    }
  }

  for (const item of ledger) {
    const forRun = item.payload.runId === run.id || (item.targetType === 'run' && item.targetId === run.id);
    if (!forRun) continue;
    if (item.action === 'finding.release' || item.action === 'finding.dismiss') {
      const release = item.action === 'finding.release';
      rows.push({
        key: item.eventId,
        group: release ? 'Release' : 'Dismissal',
        verb: release ? 'Released' : 'Dismissed',
        subject: { text: title(item.targetId), mono: false },
        detail: null,
        reason: str(item.payload.reason),
        who: who(item.actor.name),
        at: item.at,
      });
    } else if (item.action === 'run.kill') {
      rows.push({ key: item.eventId, group: 'Stop', verb: 'Stopped testing', subject: null, detail: null, reason: null, who: who(item.actor.name), at: item.at });
    }
  }

  for (const e of run.events)
    if (e.kind === 'finding.released' && e.data.auto === true) {
      const id = str(e.data.findingId);
      rows.push({
        key: `auto-${e.seq}`,
        group: 'Release',
        verb: 'Released automatically',
        subject: { text: id === null ? str(e.data.title) ?? 'a finding' : title(id), mono: false },
        detail: 'as you chose on the plan',
        reason: null,
        who: null,
        at: e.at,
      });
    }

  return rows.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

const ACTIONS: Readonly<Record<string, string>> = {
  'workspace.named': 'Named the workspace',
  'gate1.approve': 'Approved a plan',
  'gate1.reject': 'Rejected a plan',
  'gate2.approve': 'Allowed a request',
  'gate2.deny': 'Denied a request',
  'finding.release': 'Released a finding',
  'finding.dismiss': 'Dismissed a finding',
  'run.kill': 'Stopped an audit',
};

/** A ledger action in words; an action without words shows as itself. */
export const actionLabel = (action: string): string => ACTIONS[action] ?? action;
