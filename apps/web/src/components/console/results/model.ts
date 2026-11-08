// Results model (experience spec §7): pure functions over the run DTO, the request and the ledger. Every number and
// sentence here is derived from what the runner and the API recorded; nothing is estimated.
import { z } from 'zod';

import { scrub, scrubDeep } from '@blackwing/errors/scrub';

import { finishedWhy } from '../../../lib/host-lines';
import { resultsHeadline } from '../../../lib/plan-text';
import { findingSchema, type AssessmentRequest, type Coverage, type Run } from '../../../lib/schemas';
import { pathOf, shortId } from '../run-model';

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

/**
 * A finding plus how its negative control behaved (`replay.control`), for "the control behaved as expected". Everything
 * taken from the site or written by the model is scrubbed of tokens, cookies and passwords here, so no page or report
 * that shows a finding can print one (the API scrubs too; this covers anything it missed).
 */
export const findingDetailSchema = findingSchema
  .extend({
    replay: z
      .object({
        control: z.object({ status: z.number(), matched: z.boolean() }).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .transform((f) => ({
    ...f,
    title: scrub(f.title),
    description: f.description === null ? null : scrub(f.description),
    reproCurl: scrub(f.reproCurl),
    oracle: f.oracle.value === undefined ? f.oracle : { ...f.oracle, value: scrub(f.oracle.value) },
    evidence: scrubDeep(f.evidence),
  }));
export type FindingDetail = z.infer<typeof findingDetailSchema>;

/** "Seen before in audit 01A1B919": the same issue (same site, method, path and weakness) in an earlier audit. */
export const seenBeforeText = (f: Pick<FindingSummary, 'seenBefore'>): string | null =>
  f.seenBefore === null ? null : `Seen before in audit ${shortId(f.seenBefore.runId)}`;

/** The findings filters (shared by the server page, which reads the URL, and the client list). */
export const FINDING_STATUSES = [
  { key: 'confirmed', label: 'Awaiting release' },
  { key: 'released', label: 'Released' },
  { key: 'suspected', label: 'Kept back' },
  { key: 'dismissed', label: 'Dismissed' },
] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_ORDER: readonly string[] = SEVERITIES;
const rank = (severity: string): number => {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Severity first, then the oldest first (the API has no confidence on summaries). Results and Findings share it. */
export function bySeverity(a: FindingSummary, b: FindingSummary): number {
  return (
    rank(a.severity) - rank(b.severity) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
  );
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
  for (const f of run.findings)
    (confirmed.has(f.id) || f.status === 'confirmed' ? proven : kept).push(f);
  return { proven: proven.sort(bySeverity), kept: kept.sort(bySeverity) };
}

export interface CaseCounts {
  readonly executed: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly total: number;
}

/**
 * Test cases and how each ended: the runner's coverage when it recorded one (it also counts the cases nobody ran), else
 * the plan events (the latest plan total and each case's last status).
 */
export function testCases(events: readonly RunEvent[], coverage: Coverage | null = null): CaseCounts {
  if (coverage !== null && coverage.cases.length > 0) {
    const n = (status: string): number => coverage.cases.filter((c) => c.status === status).length;
    return { executed: n('executed'), skipped: n('skipped'), blocked: n('blocked'), total: coverage.cases.length };
  }
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
  const ended = (status: string): number => [...latest.values()].filter((s) => s === status).length;
  const executed = ended('executed');
  return {
    executed,
    skipped: ended('skipped'),
    blocked: ended('blocked'),
    total: Math.max(total, ids.size, executed),
  };
}

/**
 * The results H1 from the template (lib/plan-text): the count is every proven issue (as on the report card), the advice
 * ("Fix the critical one first") only counts the ones still awaiting your decision, so it disappears once all are decided. The compound word keeps
 * a non-breaking hyphen, so the headline never splits "high-severity".
 */
export function headline(proven: readonly FindingSummary[]): string {
  const all = proven.map((f) => f.severity);
  // Advice only while something still awaits your decision: once all are decided the page says so instead.
  const open = proven.filter((f) => f.status === 'confirmed').map((f) => f.severity);
  // resultsHeadline of only-low severities is the bare count sentence, so it measures the advice that follows.
  const bare = (list: readonly string[]): string => resultsHeadline(list.map(() => 'low'));
  const advice = resultsHeadline(open).slice(bare(open).length);
  // Proven is not the same as reported: say how many of them were dismissed (by a person, or as repeats of a newer proof).
  const dismissed = proven.filter((f) => f.status === 'dismissed').length;
  const gone = dismissed === 0 ? '' : ` ${dismissed === 1 ? '1 is' : `${dismissed} are`} dismissed.`;
  return `${bare(all)}${gone}${open.length === 0 ? '' : advice}`.replace(
    'high-severity',
    'high\u2011severity',
  );
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

/**
 * Why cases did not run, in words. "Blocked" is the model's own status; when the audit had a request that was denied,
 * that is the plain reason (the agent needed it), otherwise the safety rules or "could not run".
 */
function notRun(cases: CaseCounts, run: Pick<Run, 'events' | 'gate2'>, planDone: boolean): string[] {
  // A person's "deny" has no close reason; an expiry or an ask the run closed at its end was simply not answered.
  const denied = run.gate2.some((g) => g.status === 'denied' && g.closeReason === null);
  const runClosed = run.gate2.some((g) => g.closeReason === 'run_ended' || g.closeReason === 'killed');
  const unanswered = run.gate2.some((g) => g.status !== 'pending' && g.status !== 'approved');
  const refused = run.events.some((e) => e.kind === 'policy.blocked');
  const b = cases.blocked;
  const were = (n: number): string => (n === 1 ? 'was' : 'were');
  const it = b === 1 ? 'it' : 'they';
  const blocked =
    b === 0
      ? null
      : denied
        ? `${b} ${were(b)} skipped because the request ${it} needed was denied`
        : unanswered
          ? `${b} ${were(b)} skipped because the request ${it} needed ${runClosed ? 'was not answered before the audit ended' : 'got no answer in time'}`
          : refused
          ? `${b} ${were(b)} stopped by the safety rules`
          : `${b} could not run`;
  const rest = cases.total - cases.executed - cases.skipped - cases.blocked;
  return [
    blocked,
    cases.skipped > 0 && !planDone ? `${cases.skipped} ${were(cases.skipped)} skipped by Claude` : null,
    rest > 0 ? `${rest} ${were(rest)} not tried` : null,
  ].filter((x): x is string => x !== null);
}

const NOT_RUN_BECAUSE: Readonly<Record<string, string>> = {
  killed: 'you stopped the audit first',
  duration_budget: 'the time limit came first',
  request_budget: 'the request budget ran out first',
  cost_cap: 'the spend cap came first',
  max_turns: 'Claude reached its turn limit first',
};

const NOTE_MAX = 1200;

/**
 * Claude's own "what was not covered" from its run summary (the part after a line that says so), scrubbed and clipped.
 * The rest of the summary never goes in: it is written about suspected and dismissed issues too.
 */
function claudeNotCovered(summary: string | null): string | null {
  if (summary === null) return null;
  const lines = summary.split('\n');
  const at = lines.findIndex((l) => /\bnot (covered|tested)\b/i.test(l));
  if (at === -1) return null;
  const rest: string[] = [];
  for (const [i, line] of lines.slice(at).entries()) {
    // The note ends at the next heading, however Claude marked it (#, a bold line, or a short "Title:" line): what
    // follows is about confirmed, suspected or dismissed issues and must never reach a report.
    if (i > 0 && (/^\s*#/.test(line) || /^\s*(\*\*|__)[^*_]+(\*\*|__):?\s*$/.test(line) || /^\s*[A-Z][^.:]{0,60}:\s*$/.test(line))) break;
    rest.push(line);
  }
  const text = scrub(rest.join('\n').trim());
  if (text === '') return null;
  if (text.length <= NOTE_MAX) return text;
  // Clip at the end of a sentence or line, never mid-word.
  const head = text.slice(0, NOTE_MAX);
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  return cut > NOTE_MAX / 2 ? head.slice(0, cut + 1).trim() : `${head.slice(0, head.lastIndexOf(' '))}…`;
}

/**
 * An agent's note is written at one moment ("pending Gate 2"); a report is read after the decision. Say what was true
 * then, in plain words, with no internal ids or gate numbers.
 */
function plainGate(note: string): string {
  return note
    .replace(/\s*\(?\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\)?/gi, '')
    .replace(/\b(?:awaiting|pending) Gate 2\b/gi, 'held for your approval when this was recorded')
    .replace(/\bGate 2\b/g, 'your approval');
}

export interface NotTested {
  /** False when the runner recorded no coverage for this run (older runs): the rows then hold only what the plan says. */
  readonly recorded: boolean;
  readonly rows: readonly { readonly what: string; readonly why: string }[];
  /** Claude's own "not covered" from its run summary (not verified), or null. */
  readonly note: string | null;
}

/**
 * "What was not tested and why", from the runner's coverage (every case that did not run, with the agent's note or the
 * reason the run ended) and the paths the plan left out. Notes are the agents' words and are scrubbed like evidence.
 */
export function notTested(input: {
  readonly coverage: Coverage | null;
  readonly endReason: unknown;
  readonly excludedPaths: readonly string[];
  readonly summary?: string | null;
}): NotTested {
  const { coverage, endReason } = input;
  const ended =
    typeof endReason === 'string' && endReason !== ''
      ? (NOT_RUN_BECAUSE[endReason] ?? 'the run stopped with an error first')
      : 'Claude ended the audit before trying it';
  const rows: { what: string; why: string }[] = (coverage?.cases ?? []).flatMap((c) => {
    if (c.status === 'executed') return [];
    const note = c.note === null || c.note.trim() === '' ? null : plainGate(scrub(c.note.trim()));
    const why =
      c.status === 'skipped'
        ? `Skipped: ${note ?? 'Claude judged it not relevant'}`
        : c.status === 'blocked'
          ? `Blocked: ${note ?? 'a request it needed was refused or denied'}`
          : c.status === 'model_declined'
            ? `Declined by Claude: ${note ?? 'no reason given'}`
            : `Not tried: ${ended}`;
    return [{ what: scrub(c.title) || c.id, why }];
  });
  if (input.excludedPaths.length > 0)
    rows.push({ what: input.excludedPaths.join(', '), why: 'Left out on purpose: the plan excluded these paths' });
  return { recorded: coverage !== null, rows, note: claudeNotCovered(input.summary ?? null) };
}

/** "a, b and c". */
const listWords = (parts: readonly string[]): string =>
  parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;

/**
 * Why a completed run ended, always as a sentence about Claude (the run page's template, lib/host-lines): the runner's
 * reason (time limit, request budget, spend cap), then how far it got through its plan and why the rest did not run.
 */
function completedWhy(
  reason: unknown,
  cases: CaseCounts | undefined,
  run: Pick<Run, 'events' | 'gate2'> & Partial<Pick<Run, 'summary'>>,
): { text: string; complete: boolean } {
  const why = finishedWhy(reason, cases ?? null);
  // A plan that ran in full is still not "complete" when Claude itself names what it did not cover: no green tick.
  if (why.complete && claudeNotCovered(run.summary ?? null) !== null)
    return { text: `${why.text}; Claude names what it did not cover below`, complete: false };
  // "finished its plan … and skipped N" already names the skips; the not-tested list gives Claude's reasons.
  const rest = cases === undefined || why.complete ? [] : notRun(cases, run, why.text.startsWith('Claude finished its plan'));
  return { text: `${why.text}${rest.length === 0 ? '' : `; ${listWords(rest)}`}`, complete: why.complete };
}

/** The eyebrow over the results headline: how long it ran and why it stopped, in words. */
export function stopLine(
  run: Pick<Run, 'state' | 'startedAt' | 'finishedAt' | 'createdAt' | 'events' | 'gate2'> & Partial<Pick<Run, 'summary'>>,
  now: number,
  cases?: CaseCounts,
): { tone: 'ok' | 'warn' | 'muted' | 'bad'; text: string } {
  // Every clock starts when the run started, never while it waited in the queue.
  const start = run.startedAt === null ? null : Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  const took = duration(start === null ? 0 : end - start);
  switch (run.state) {
    case 'completed': {
      const done = run.events.findLast((e) => e.kind === 'run.completed');
      const why = completedWhy(done?.data.reason, cases, run);
      // A green tick only for a plan that ran in full; a limit or untried cases read as a warning.
      return { tone: why.complete ? 'ok' : 'warn', text: `Finished in ${took} · ${why.text}` };
    }
    case 'killed':
      return {
        tone: 'muted',
        text: start === null ? 'Stopped before it started · you stopped testing' : `Stopped after ${took} · you stopped testing`,
      };
    case 'failed': {
      const failed = run.events.findLast((e) => e.kind === 'run.failed');
      const why = str(failed?.data.reason);
      return {
        tone: 'bad',
        text: `Stopped after ${took} · the run ended with an error${why === null ? '' : ` (${why})`}`,
      };
    }
    default:
      return {
        tone: 'muted',
        text:
          start === null
            ? 'Waiting to start. Nothing has been sent to the site yet.'
            : `Still testing · ${took} so far. These are the results until now.`,
      };
  }
}

/**
 * "both denied", "allowed", "1 allowed, 2 denied" for the report card's "Decisions asked" (after the count). An ask
 * nobody answered (an expiry, or one the run closed when it ended) is "not answered", never "denied".
 */
export function gate2Outcome(gate2: Run['gate2']): { asked: number; label: string } {
  const decided = gate2.filter((g) => g.status !== 'pending');
  const allowed = decided.filter((g) => g.status === 'approved').length;
  const denied = decided.filter((g) => g.status === 'denied' && g.closeReason === null).length;
  const unanswered = decided.length - allowed - denied;
  const pending = gate2.length - decided.length;
  const parts: string[] = [];
  if (allowed > 0) parts.push(`${allowed} allowed`);
  if (denied > 0) parts.push(`${denied} denied`);
  if (unanswered > 0) parts.push(`${unanswered} not answered`);
  if (pending > 0) parts.push(`${pending} open`);
  // The card puts " · " between the count and this label ("2 · both denied", "3 · 1 allowed, 2 denied").
  let label = parts.join(', ');
  if (parts.length === 1) {
    const word = (parts[0] ?? '').replace(/^\d+ /, '');
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
  /** Who decided: "you", another person's name, or null when Blackwing decided on its own (an expiry, a plan rule). */
  readonly by: string | null;
  readonly at: string | null;
}


/**
 * "Your decisions" for one run: Gate 1 (the request), Gate 2 (the run's decisions, with expiries), Gate 3 and stop
 * (the ledger), and automatic releases (run events). Oldest first.
 */
export function decisions(input: {
  readonly run: Pick<Run, 'id' | 'events' | 'findings' | 'gate2'>;
  readonly request: Pick<
    AssessmentRequest,
    'id' | 'status' | 'approver' | 'decisionReason' | 'decidedAt'
  > | null;
  readonly ledger: readonly LedgerItem[];
  readonly viewerName: string;
  readonly gate2TimeoutS: number | null;
}): DecisionRow[] {
  const { run, request, ledger, viewerName } = input;
  const who = (name: string | null | undefined): string | null =>
    name === null || name === undefined ? null : name === viewerName ? 'you' : name;
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
      by: who(request.approver?.name),
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
      rows.push({
        key: g.id,
        group: 'Request',
        verb: 'Allowed',
        subject,
        detail: [asRole, 'for this run'].filter(Boolean).join(' '),
        reason: g.decisionReason,
        by: who(g.decidedBy),
        at,
      });
    } else if (g.closeReason !== null && g.closeReason !== 'deadline') {
      // The run closed it (it ended or was stopped): nobody answered, nobody denied it, and it was not sent.
      rows.push({
        key: g.id,
        group: 'Request',
        verb: 'Not sent',
        subject,
        detail: [asRole, g.closeReason === 'killed' ? 'the audit was stopped before anyone answered' : 'not answered before the audit ended']
          .filter(Boolean)
          .join(', '),
        reason: null,
        by: null,
        at,
      });
    } else if (g.status === 'expired') {
      const total =
        input.gate2TimeoutS ??
        (g.createdAt === undefined
          ? null
          : (Date.parse(g.deadlineAt) - Date.parse(g.createdAt)) / MS_PER_S);
      const wait =
        total === null
          ? 'no answer in time'
          : `no answer in ${Math.max(1, Math.round(total / S_PER_MIN))} min`;
      rows.push({
        key: g.id,
        group: 'Request',
        verb: 'Denied automatically',
        subject,
        detail: [asRole, wait].filter(Boolean).join(', '),
        reason: null,
        by: null,
        at,
      });
    } else if (g.decidedBy === null) {
      rows.push({
        key: g.id,
        group: 'Request',
        verb: 'Denied automatically',
        subject,
        detail: 'the audit was stopping',
        reason: null,
        by: null,
        at,
      });
    } else {
      rows.push({
        key: g.id,
        group: 'Request',
        verb: 'Denied',
        subject,
        detail: asRole,
        reason: g.decisionReason,
        by: who(g.decidedBy),
        at,
      });
    }
  }

  for (const item of ledger) {
    const forRun =
      item.payload.runId === run.id || (item.targetType === 'run' && item.targetId === run.id);
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
        by: who(item.actor.name),
        at: item.at,
      });
    } else if (item.action === 'run.kill') {
      rows.push({
        key: item.eventId,
        group: 'Stop',
        verb: 'Stopped testing',
        subject: null,
        detail: null,
        reason: null,
        by: who(item.actor.name),
        at: item.at,
      });
    }
  }

  for (const e of run.events)
    if (e.kind === 'finding.released' && e.data.auto === true) {
      const id = str(e.data.findingId);
      rows.push({
        key: `auto-${e.seq}`,
        group: 'Release',
        verb: 'Released automatically',
        subject: {
          text: id === null ? (str(e.data.title) ?? 'a finding') : title(id),
          mono: false,
        },
        detail: 'as you chose on the plan',
        reason: null,
        by: null,
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
  'finding.reopen': 'Reopened a dismissed finding',
  'finding.superseded': 'Merged a repeated finding into its newer proof',
  'run.kill': 'Stopped an audit',
};

/** The reason the plan form records when an edited plan replaces the draft (audits/actions.ts): not a rejection. */
export const PLAN_REPLACED_REASON = 'Replaced by an edited plan';

/** A ledger action in words; an action without words shows as itself. A replaced draft reads as the edit it was. */
export const actionLabel = (
  action: string,
  payload: Readonly<Record<string, unknown>> = {},
): string =>
  action === 'gate1.reject' && payload.reason === PLAN_REPLACED_REASON
    ? 'Edited a plan (replaced the draft)'
    : (ACTIONS[action] ?? action);
