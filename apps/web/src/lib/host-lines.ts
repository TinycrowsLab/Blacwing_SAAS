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
      return "Claude's team started work.";
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
      const ms = num(d.haltMs);
      return ms === null ? 'Stopped. Every agent halted.' : `Stopped. Every agent halted in ${ms.toLocaleString('en-US')} ms.`;
    }
    case 'run.completed':
      // Without a reason the planner ended on its own: "Finished: finished its plan" would stutter.
      return `Finished: ${str(d.reason) === null ? 'Claude completed its plan' : finishReason(d.reason)}. Your results are ready.`;
    case 'run.failed':
      return `The run stopped with an error: ${str(d.reason) ?? 'unknown'}. Findings so far are kept.`;
    default:
      return null;
  }
}
