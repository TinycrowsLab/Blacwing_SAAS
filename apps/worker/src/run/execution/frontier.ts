import type { ExecutionEvent, FrontierCounts, FrontierSnapshot } from './types.js';

// Pure rules of the execution phase (ORCH-008). Imported by the workflow bundle, so no I/O and no clock.

/** True when nothing is left to dispatch and every dispatched subtask is terminal. */
export function isExhausted(counts: FrontierCounts): boolean {
  return (
    counts.eligible === 0 &&
    counts.open === 0 &&
    counts.inFlight === 0 &&
    counts.awaitingGate2 === 0
  );
}

/** Builds the snapshot the workflow reads: counts plus the derived `exhausted` and `marker`. */
export function toSnapshot(counts: FrontierCounts, runTerminal: boolean): FrontierSnapshot {
  return {
    ...counts,
    exhausted: isExhausted(counts),
    runTerminal,
    marker: [
      counts.eligible,
      counts.open,
      counts.inFlight,
      counts.awaitingGate2,
      counts.terminal,
      counts.activitySeq,
    ].join(':'),
  };
}

/** Consecutive no-progress observations, reset whenever the marker changes. */
export interface StallState {
  readonly marker: string | null;
  readonly ticks: number;
}

export const INITIAL_STALL: StallState = { marker: null, ticks: 0 };

/**
 * Folds one observation into the stall state. Only observations that end a wait without news (a poll
 * timeout, or the orchestrator stopping) should be counted: pass `countable = false` for the others.
 */
export function observe(state: StallState, marker: string, countable: boolean): StallState {
  if (marker !== state.marker) return { marker, ticks: 0 };
  return countable ? { marker, ticks: state.ticks + 1 } : state;
}

export function isStalled(state: StallState, stallPolls: number): boolean {
  return state.ticks >= stallPolls;
}

export type Intervention =
  { readonly kind: 'mentor'; readonly reflector: boolean } | { readonly kind: 'pause' };

/**
 * What a stall earns. The first intervention is a mentor review; after a failed one a reflector joins
 * (repeated failure); once `max` interventions did not help the run pauses for an operator.
 * Both are advice only: the pause is the deterministic control (§8.11).
 */
export function nextIntervention(done: number, max: number): Intervention {
  if (done >= max) return { kind: 'pause' };
  return { kind: 'mentor', reflector: done >= 1 };
}

/**
 * `defer` suspends a single call; for a parallel batch it is ignored, so the hook can only deny
 * with a reason and the branch is paused instead of waiting on a human (CONTEXT_PACK §4.3).
 */
export function classifyOutOfEnvelope(
  event: Extract<ExecutionEvent, { type: 'out_of_envelope_call' }>,
): 'gate2' | 'deny_and_pause' {
  return event.toolCallsInTurn === 1 ? 'gate2' : 'deny_and_pause';
}

const SUMMARY_MAX = 200;
const LAST_C0 = 0x1f;
const FIRST_DEL = 0x7f;
const LAST_C1 = 0x9f;

/** Strips control characters and truncates untrusted text before it reaches a page or a row. */
export function sanitiseSummary(text: string): string {
  // Control characters (C0, DEL, C1) would let untrusted text forge lines in pages and audit views.
  let clean = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    clean += code <= LAST_C0 || (code >= FIRST_DEL && code <= LAST_C1) ? ' ' : ch;
  }
  clean = clean.replace(/ {2,}/g, ' ').trim();
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
}
