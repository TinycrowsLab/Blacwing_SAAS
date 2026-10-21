import { Cron } from 'croner';

import { fromIso, isValidTimeZone, toIso } from '@blackwing/time';

import type { SaTimeline, SaTimeBounds } from './types.js';

/**
 * ORCH-014: pure time math for a standing authorisation's bounds (CONTEXT_PACK §7 `test_windows`,
 * `valid_from`, `expires_at`). Everything here is a function of its inputs; the clock is passed in.
 *
 * - A test window is `{ cron, timezone, durationMs }`: it opens at every instant the cron expression
 *   matches on the wall clock of the IANA `timezone` (croner resolves DST gaps and overlaps, so no
 *   fixed offsets are used) and stays open for `durationMs` of real time.
 * - Windows are evaluated in their own zone; all instants in and out are ISO-8601 UTC.
 * - Fail safe: a window whose cron or zone cannot be evaluated contributes no open time (counted in
 *   `invalidWindows`), so it can only make the SA more closed, never more open.
 * - An SA with an empty `testWindows` list carries no window restriction: it is open from `validFrom`
 *   to `expiresAt`.
 */

/** Occurrences examined per window and lookup; a pathological cron (every second, 7-day window) is dropped. */
const MAX_OCCURRENCES = 300;
/** Passes of the overlap-merge loop; each pass either extends the open run or stops. */
const MAX_MERGE_PASSES = 64;

interface CompiledWindow {
  readonly cron: Cron;
  readonly durationMs: number;
}

class WindowEvaluationError extends Error {}

function compile(window: SaTimeBounds['testWindows'][number]): CompiledWindow | null {
  if (!isValidTimeZone(window.timezone)) return null;
  if (!Number.isSafeInteger(window.durationMs) || window.durationMs <= 0) return null;
  try {
    return {
      cron: new Cron(window.cron, { timezone: window.timezone, paused: true }),
      durationMs: window.durationMs,
    };
  } catch {
    return null;
  }
}

/** Window opening instants (epoch ms) in `[fromMs, toMs]`, oldest first. */
function startsBetween(window: CompiledWindow, fromMs: number, toMs: number): number[] {
  const starts: number[] = [];
  let cursor = new Date(fromMs - 1);
  for (;;) {
    const next = window.cron.nextRun(cursor);
    if (next === null || next.getTime() > toMs) return starts;
    if (starts.length >= MAX_OCCURRENCES) throw new WindowEvaluationError('too many occurrences');
    starts.push(next.getTime());
    cursor = next;
  }
}

function nextStartAfter(window: CompiledWindow, ms: number): number | null {
  const next = window.cron.nextRun(new Date(ms));
  return next === null ? null : next.getTime();
}

/** End of the merged open run containing `atMs`, or null when no window is open then. */
function openRunEnd(windows: readonly CompiledWindow[], atMs: number): number | null {
  let end: number | null = null;
  for (const w of windows) {
    for (const s of startsBetween(w, atMs - w.durationMs, atMs)) {
      const e = s + w.durationMs;
      if (e > atMs && (end === null || e > end)) end = e;
    }
  }
  if (end === null) return null;
  // Overlapping or abutting windows keep traffic flowing across the seam, so extend over them.
  for (let pass = 0; pass < MAX_MERGE_PASSES; pass += 1) {
    const before: number = end;
    for (const w of windows) {
      for (const s of startsBetween(w, atMs, before)) {
        end = Math.max(end, s + w.durationMs);
      }
    }
    if (end === before) return end;
  }
  return end;
}

function nextOpenAfter(windows: readonly CompiledWindow[], atMs: number): number | null {
  let best: number | null = null;
  for (const w of windows) {
    const s = nextStartAfter(w, atMs);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

/**
 * Where the SA stands at `now`: `expired` (terminal), `open` (traffic allowed until `closeAt`) or
 * `closed` (nothing until `nextOpenAt`, which is null when no window opens before expiry).
 * `closeAt` never exceeds `expiresAt`.
 */
export function computeSaTimeline(bounds: SaTimeBounds, now: Date): SaTimeline {
  const nowMs = now.getTime();
  let expMs: number;
  let vfMs: number;
  try {
    expMs = fromIso(bounds.expiresAt).getTime();
    vfMs = fromIso(bounds.validFrom).getTime();
  } catch {
    // Unreadable bounds cannot prove the SA is still valid, so the run stops (fail closed, §8.2).
    return {
      now: toIso(now),
      phase: 'expired',
      expiresAt: toIso(now),
      closeAt: null,
      nextOpenAt: null,
      invalidWindows: 0,
    };
  }
  const base = { now: toIso(now), expiresAt: toIso(new Date(expMs)) };
  if (nowMs >= expMs) {
    return { ...base, phase: 'expired', closeAt: null, nextOpenAt: null, invalidWindows: 0 };
  }

  const compiled = bounds.testWindows.map((w) => compile(w));
  const windows = compiled.filter((w): w is CompiledWindow => w !== null);
  const invalidWindows = compiled.length - windows.length;
  const unrestricted = bounds.testWindows.length === 0;
  const ref = Math.max(nowMs, vfMs);

  let closeMs: number | null;
  let nextMs: number | null;
  try {
    closeMs = unrestricted ? expMs : openRunEnd(windows, ref);
    nextMs = closeMs === null ? nextOpenAfter(windows, ref) : null;
  } catch (err) {
    if (!(err instanceof WindowEvaluationError)) throw err;
    closeMs = null;
    nextMs = null;
  }

  if (nowMs < vfMs) {
    // Not yet valid: closed until validFrom (if a window is open then) or the next window start.
    const openAtValidFrom = closeMs !== null;
    const opens = openAtValidFrom ? vfMs : nextMs;
    return {
      ...base,
      phase: 'closed',
      closeAt: null,
      nextOpenAt: opens !== null && opens < expMs ? toIso(new Date(opens)) : null,
      invalidWindows,
    };
  }
  if (closeMs !== null) {
    return {
      ...base,
      phase: 'open',
      closeAt: toIso(new Date(Math.min(closeMs, expMs))),
      nextOpenAt: null,
      invalidWindows,
    };
  }
  return {
    ...base,
    phase: 'closed',
    closeAt: null,
    nextOpenAt: nextMs !== null && nextMs < expMs ? toIso(new Date(nextMs)) : null,
    invalidWindows,
  };
}
