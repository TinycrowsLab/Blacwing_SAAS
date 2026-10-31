import type { StallWindow, StallWindowEvent, ToolEvent, TurnEvent } from './stall-window.js';
import type { StallThresholds, StallThresholdsOverride } from '@blackwing/config';

/**
 * Deterministic stall and loop rules (MENTOR-001, #420, CONTEXT_PACK §8.11). Detection is code, not model
 * judgement. A signal only advises the mentor: nothing here changes a permission, a budget or a policy
 * decision, and the detector writes nothing (no DB, no stream).
 *
 * Every rule looks at the current progress segment: the events after the last progress marker (a turn with
 * evidence, a subtask-status change or a new surface node, or a subtask start/completion). A legitimately long
 * session that keeps progressing therefore never accumulates a loop count, and sparse telemetry cannot fire
 * `no_progress` before the window holds enough turns. `time_box` alone reads timestamps, so it still applies
 * when turns are quiet.
 */

export type StallReason = 'no_progress' | 'tool_loop' | 'error_loop' | 'budget_crawl' | 'time_box';
export type StallSeverity = 'low' | 'medium' | 'high';

export interface StallSignal {
  readonly stalled: boolean;
  /** Fired reasons, in the fixed rule order. Empty when not stalled. */
  readonly reasons: readonly StallReason[];
  /** `low` for one reason, `medium` for two, `high` for three or more, and `low` when not stalled. */
  readonly severity: StallSeverity;
}

/** Observer port: the default adapter records metrics and logs; tests pass an in-memory one. */
export interface StallObserver {
  evaluated(input: {
    readonly sessionId: string;
    readonly signal: StallSignal;
    readonly durationMs: number;
  }): void;
}

const NO_OP_OBSERVER: StallObserver = { evaluated: () => undefined };

export interface StallDetectorOptions {
  readonly thresholds: StallThresholds;
  /** Per-persona overrides, merged onto `thresholds` by {@link StallDetector.forPersona}. */
  readonly personaOverrides?: Readonly<Record<string, StallThresholdsOverride>>;
  readonly observer?: StallObserver;
}

const MS_PER_MINUTE = 60_000;
/** Reason count at which severity becomes `high`. */
const HIGH_SEVERITY_REASONS = 3;

/** Last progress marker in the window, or -1 when the whole window is one progress-free segment. */
function lastProgressIndex(events: readonly StallWindowEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.kind === 'subtask') return i;
    if (e.kind === 'turn' && isProgress(e)) return i;
  }
  return -1;
}

function isProgress(turn: TurnEvent): boolean {
  return (
    turn.progress.evidence > 0 || turn.progress.subtaskChanges > 0 || turn.progress.surfaceNodes > 0
  );
}

/** Turns with no progress since the last progress marker: the `no_progress` count. */
function noProgressTurns(segment: readonly StallWindowEvent[]): number {
  return segment.filter((e) => e.kind === 'turn').length;
}

function toolsIn(segment: readonly StallWindowEvent[]): ToolEvent[] {
  return segment.filter((e): e is ToolEvent => e.kind === 'tool');
}

/** Longest run of identical `(tool, argsHash)` calls in the segment. */
function maxToolRepeats(tools: readonly ToolEvent[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const t of tools) {
    const key = `${t.tool}\u0000${t.argsHash}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > max) max = n;
  }
  return max;
}

/** Trailing run of failed calls that share one error kind (denials count as failures). */
function trailingErrorRun(tools: readonly ToolEvent[]): number {
  let run = 0;
  let kind: string | undefined;
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (!t || t.outcome === 'ok') break;
    const k = t.errorKind ?? t.outcome;
    kind ??= k;
    if (k !== kind) break;
    run++;
  }
  return run;
}

function timeBoxExceeded(
  events: readonly StallWindowEvent[],
  now: string,
  maxMinutes: number,
): boolean {
  // The open subtask is the most recent start with no later completion for the same subtask.
  const open = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== 'subtask') continue;
    if (e.status === 'started') open.set(e.subtaskId, e.at);
    else open.delete(e.subtaskId);
  }
  const starts = [...open.values()];
  if (starts.length === 0) return false;
  const oldest = starts.reduce((a, b) => (b < a ? b : a));
  const elapsedMs = Date.parse(now) - Date.parse(oldest);
  return elapsedMs > maxMinutes * MS_PER_MINUTE;
}

/** Severity from the number of concurrent reasons: one is low, two medium, three or more high. */
function severityFor(reasonCount: number): StallSeverity {
  if (reasonCount >= HIGH_SEVERITY_REASONS) return 'high';
  if (reasonCount === 2) return 'medium';
  return 'low';
}

/**
 * The stall rules bound to one threshold set. Pure: `evaluate` reads the window and returns a signal.
 * Its only side effect is the observer callback, which the Run Controller path uses for metrics and logs.
 */
export class StallDetector {
  readonly thresholds: StallThresholds;
  private readonly personaOverrides: Readonly<Record<string, StallThresholdsOverride>>;
  private readonly observer: StallObserver;

  constructor(options: StallDetectorOptions) {
    this.thresholds = options.thresholds;
    this.personaOverrides = options.personaOverrides ?? {};
    this.observer = options.observer ?? NO_OP_OBSERVER;
  }

  /**
   * A detector whose thresholds are the base set with the persona's override applied on top. A persona with no
   * override keeps the base set. Overrides only change the thresholds; they never change what the mentor does.
   */
  forPersona(persona: string): StallDetector {
    const override = Object.hasOwn(this.personaOverrides, persona)
      ? this.personaOverrides[persona]
      : undefined;
    if (override === undefined) return this;
    return new StallDetector({
      thresholds: {
        noProgressTurns: override.noProgressTurns ?? this.thresholds.noProgressTurns,
        toolLoopRepeats: override.toolLoopRepeats ?? this.thresholds.toolLoopRepeats,
        errorLoop: override.errorLoop ?? this.thresholds.errorLoop,
        budgetDeltaUsd: override.budgetDeltaUsd ?? this.thresholds.budgetDeltaUsd,
        subtaskMaxMinutes: override.subtaskMaxMinutes ?? this.thresholds.subtaskMaxMinutes,
      },
      observer: this.observer,
    });
  }

  evaluate(window: StallWindow): StallSignal {
    const started = performance.now();
    const signal = this.compute(window.snapshot());
    this.observer.evaluated({
      sessionId: window.sessionId,
      signal,
      durationMs: performance.now() - started,
    });
    return signal;
  }

  private compute(events: readonly StallWindowEvent[]): StallSignal {
    const t = this.thresholds;
    const last = events.at(-1);
    if (last === undefined) return { stalled: false, reasons: [], severity: 'low' };

    const segment = events.slice(lastProgressIndex(events) + 1);
    const tools = toolsIn(segment);
    const reasons: StallReason[] = [];

    if (noProgressTurns(segment) >= t.noProgressTurns) reasons.push('no_progress');
    if (maxToolRepeats(tools) >= t.toolLoopRepeats) reasons.push('tool_loop');
    if (trailingErrorRun(tools) >= t.errorLoop) reasons.push('error_loop');
    const spend = segment.reduce((sum, e) => (e.kind === 'turn' ? sum + e.costUsd : sum), 0);
    if (spend > t.budgetDeltaUsd) reasons.push('budget_crawl');
    if (timeBoxExceeded(events, last.at, t.subtaskMaxMinutes)) reasons.push('time_box');

    return {
      stalled: reasons.length > 0,
      reasons,
      severity: severityFor(reasons.length),
    };
  }
}
