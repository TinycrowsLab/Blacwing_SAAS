// Blackwing's own voice in the live conversation (experience spec §5.2): deterministic templates over run events.
// Every line states only what the event carries; an event without a line returns null.
import { agentName } from './agents';

export interface HostEvent {
  readonly kind: string;
  readonly message?: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface HostContext {
  /** The Gate 2 request a `gate2.decided` event closes (from the matching `gate2.requested` or the gate2 list). */
  readonly request?: { readonly method: string; readonly url: string } | undefined;
  /** BW_GATE2_TIMEOUT_S from GET /workspace, for "no answer in {m} min". */
  readonly gate2TimeoutS?: number | undefined;
  /** The signed-in person's name, so "Paused by {name}" reads "Paused by you" for them. */
  readonly viewerName?: string | null | undefined;
  /** How far the test plan got, for the finish line (run-model `caseTally`). */
  readonly cases?: CaseTally | null | undefined;
  /** False when the run ended before its team started (no `run.started`): a stop then names no halt time. */
  readonly started?: boolean | undefined;
}

export interface CaseTally {
  readonly executed: number;
  /** Cases Blackwing skipped with a reason: the plan is done, but they did not run. */
  readonly skipped?: number;
  readonly total: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const SECONDS_PER_MINUTE = 60;

/** `run.completed.data.reason` in words. */
export function finishReason(reason: unknown): string {
  switch (reason) {
    case 'duration_budget':
      return 'stopped at the time limit';
    case 'request_budget':
      return 'used its request budget';
    case 'cost_cap':
      return 'reached the spend cap';
    case 'max_turns':
      return 'reached its turn limit';
    default:
      return 'finished its plan';
  }
}

const LIMITS: ReadonlySet<unknown> = new Set(['duration_budget', 'request_budget', 'cost_cap', 'max_turns']);

/**
 * The one finish sentence (run page and results): the runner's limit when it named one, then how far the test plan got.
 * `complete` only when every planned case ran and no limit stopped it; anything else is never shown as a clean finish.
 */
export function finishedWhy(reason: unknown, cases: CaseTally | null | undefined): { text: string; complete: boolean } {
  const limit = LIMITS.has(reason) ? finishReason(reason) : null;
  const total = cases?.total ?? 0;
  const executed = Math.min(cases?.executed ?? 0, total);
  if (total === 0) return { text: limit === null ? 'Blackwing ended the audit' : `Blackwing ${limit}`, complete: false };
  const all = `all ${total} planned test ${total === 1 ? 'case' : 'cases'}`;
  if (executed >= total)
    return limit === null
      ? { text: `Blackwing finished its plan: it ran ${all}`, complete: true }
      : { text: `Blackwing ${limit} after it ran ${all}`, complete: false };
  const ran = `ran ${executed} of ${total} planned test cases`;
  const skipped = Math.min(cases?.skipped ?? 0, total - executed);
  if (limit === null && executed + skipped >= total)
    return { text: `Blackwing finished its plan: it ${ran} and skipped ${skipped}`, complete: false };
  return { text: limit === null ? `Blackwing ended the audit early: it ${ran}` : `Blackwing ${limit} after it ${ran}`, complete: false };
}

function requestLabel(request: HostContext['request']): string {
  if (request === undefined) return 'the request';
  let path = request.url;
  try {
    path = new URL(request.url).pathname;
  } catch {
    // keep the raw value
  }
  return `${request.method.toUpperCase()} ${path}`;
}

/** "Paused by Jatin Singh." from the API's message `Run paused by Jatin Singh.` */
const byName = (message: string | undefined): string | null => /\bby (.+?)\.?$/.exec(message ?? '')?.[1] ?? null;

export function hostLine(event: HostEvent, ctx: HostContext = {}): string | null {
  const d = event.data;
  switch (event.kind) {
    case 'run.queued':
      return 'Audit queued. Scope, limits and authorisation are pinned.';
    case 'run.started':
      return "Blackwing's team started work.";
    case 'plan.cases': {
      const n = Array.isArray(d.cases) ? d.cases.length : 0;
      const total = num(d.total) ?? n;
      // The event names the agent that recorded them (a specialist can add cases too). The screen links to the plan.
      const agent = str(d.agent);
      const who = agent === null || agent === 'orchestrator' ? 'The planner' : `The ${agentName(agent)}`;
      return `${who} recorded ${n} test ${n === 1 ? 'case' : 'cases'} (${total} in the plan).`;
    }
    case 'gate2.decided': {
      const status = str(d.status);
      const what = requestLabel(ctx.request);
      if (status === 'approved') return `You allowed ${what} for this run.`;
      const closedBy = str(d.reason);
      if (closedBy === 'run_ended' || closedBy === 'killed')
        return `${what} was not sent: nobody answered before the audit ${closedBy === 'killed' ? 'was stopped' : 'ended'}.`;
      if (status === 'expired') {
        const s = ctx.gate2TimeoutS;
        return s === undefined
          ? 'Denied automatically: no answer in time.'
          : `Denied automatically: no answer in ${Math.max(1, Math.round(s / SECONDS_PER_MINUTE))} min.`;
      }
      // The worker denies without a person when the run is being stopped.
      return str(d.by) === null ? `Denied ${what}: the audit was stopping.` : `You denied ${what}.`;
    }
    case 'run.paused': {
      const who = byName(event.message);
      if (who === null) return 'Paused.';
      return `Paused by ${ctx.viewerName !== undefined && ctx.viewerName !== null && who === ctx.viewerName ? 'you' : who}.`;
    }
    case 'run.resumed':
      return 'Resumed.';
    case 'kill.requested':
      return 'Stopping: halting every agent…';
    case 'run.killed': {
      if (ctx.started === false) return 'Stopped before testing began.';
      const ms = num(d.haltMs);
      return ms === null ? 'Stopped. Every agent halted.' : `Stopped. Every agent halted in ${ms.toLocaleString('en-US')} ms.`;
    }
    case 'run.completed':
      return `Finished: ${finishedWhy(d.reason, ctx.cases).text}. Your results are ready.`;
    case 'accounts.unused': {
      const roles = Array.isArray(d.roles) ? d.roles.filter((r): r is string => typeof r === 'string') : [];
      return `No request has used your test accounts yet${roles.length === 0 ? '' : ` (${roles.join(', ')})`}. Signed-in testing has not started.`;
    }
    case 'run.continued': {
      const n = Array.isArray(d.untried) ? d.untried.length : 0;
      const allowed = num(d.approved) ?? 0;
      const parts = [
        n === 0 ? null : `${n} untried test ${n === 1 ? 'case' : 'cases'}`,
        allowed === 0 ? null : `${allowed} ${allowed === 1 ? 'request' : 'requests'} you allowed`,
      ].filter((p): p is string => p !== null);
      if (parts.length > 0) return `Blackwing sent the team back for ${parts.join(' and ')}.`;
      return d.widen === true ? 'Blackwing asked the team to widen a narrow plan before finishing.' : null;
    }
    case 'run.holding': {
      const n = Array.isArray(d.gate2Ids) ? d.gate2Ids.length : 0;
      return `The team is done for now. Blackwing keeps the audit open for your answer on ${n === 1 ? 'the request above' : `${n} requests`}; what you allow is sent before it ends.`;
    }
    case 'run.failed':
      return `The run stopped with an error: ${str(d.reason) ?? 'unknown'}. Findings so far are kept.`;
    default:
      return null;
  }
}
