/**
 * Vitest runtime wiring for test files: a fixed clock that also drives `Date`, and container logs
 * printed when a test fails. Import from test files only (it uses the Vitest runtime).
 */
import { afterEach, beforeEach, vi } from 'vitest';

import { type DurationInput, FixedClock, type InstantInput, toInstantMs } from '@blackwing/time';

import { DEFAULT_TEST_EPOCH } from '../clock.js';

/** A `FixedClock` whose moves are mirrored into Vitest's faked `Date`. */
class DateSyncedClock extends FixedClock {
  override set(instant: InstantInput): this {
    super.set(instant);
    vi.setSystemTime(this.nowMs());
    return this;
  }

  override advance(duration: DurationInput): this {
    super.advance(duration);
    vi.setSystemTime(this.nowMs());
    return this;
  }
}

/**
 * Freezes `Date` (and `Date.now()`) at `start` for every test in the enclosing file or `describe`,
 * and returns a `FixedClock` (from `@blackwing/time`) that moves the faked time with it:
 * `clock.advance('5m')` moves `Date.now()` too. Only `Date` is faked, so timers and I/O behave
 * normally. The clock is reset to `start` before each test and real time is restored after it.
 */
export function useFixedClock(start: InstantInput = DEFAULT_TEST_EPOCH): FixedClock {
  const startMs = toInstantMs(start);
  const clock = new DateSyncedClock(startMs);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    clock.set(startMs);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  return clock;
}

/** Anything with buffered container logs (every `with*` handle in `@blackwing/testing/containers`). */
export interface HasLogs {
  readonly service: string;
  logs(): string;
}

/**
 * When a test in the enclosing file or `describe` fails, writes the recent logs of the given container
 * handles to stderr. Pass a getter because handles are usually created in `beforeAll`.
 */
export function surfaceContainerLogsOnFailure(
  handles: () => readonly (HasLogs | undefined)[],
): void {
  beforeEach(({ onTestFailed }) => {
    onTestFailed(() => {
      for (const handle of handles()) {
        if (handle === undefined) continue;
        process.stderr.write(
          `\n----- ${handle.service} container logs (most recent) -----\n${handle.logs()}\n`,
        );
      }
    });
  });
}
