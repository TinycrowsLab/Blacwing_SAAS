import { type DurationInput, toDurationMs } from './duration.js';
import { fromIso, instantToMs, type IsoTimestamp, toIso } from './iso.js';

/**
 * The only source of "now" in Blackwing code. Time-dependent logic (test windows, gate timeouts,
 * standing-authorisation and envelope expiry, halt timing) takes a `Clock` through its constructor
 * instead of calling `Date.now()`, so tests drive it with a {@link FixedClock}.
 */
export interface Clock {
  /** The current instant as a new `Date`. */
  now(): Date;
  /** The current instant in epoch milliseconds. */
  nowMs(): number;
  /**
   * A monotonic reading in milliseconds, for measuring elapsed time (for example kill-switch halt
   * time, §8.5). Unrelated to the wall clock and never decreasing; only differences are meaningful.
   */
  monotonicMs(): number;
}

/** An instant given as a `Date`, epoch milliseconds or a canonical {@link IsoTimestamp}. */
export type InstantInput = Date | number | string;

/** Epoch milliseconds of an {@link InstantInput}; strings must be canonical ISO-8601 UTC. */
export function toInstantMs(value: InstantInput): number {
  return typeof value === 'string' ? fromIso(value).getTime() : instantToMs(value);
}

/** The real clock: `Date.now()` for wall time and `performance.now()` for monotonic time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date(Date.now());
  }

  nowMs(): number {
    return Date.now();
  }

  monotonicMs(): number {
    return performance.now();
  }
}

/** The process-wide {@link SystemClock}. Inject it in production wiring; inject a `FixedClock` in tests. */
export const systemClock: Clock = Object.freeze(new SystemClock());

/**
 * A clock that only moves when told to. `advance` moves wall and monotonic time together; `set`
 * steps the wall clock (forwards or backwards, like an NTP step) and leaves monotonic time alone,
 * so code that measures elapsed time can be tested against a clock jump.
 */
export class FixedClock implements Clock {
  #wallMs: number;
  #monotonicMs = 0;

  constructor(start: InstantInput) {
    this.#wallMs = toInstantMs(start);
  }

  now(): Date {
    return new Date(this.#wallMs);
  }

  nowMs(): number {
    return this.#wallMs;
  }

  monotonicMs(): number {
    return this.#monotonicMs;
  }

  /** Steps the wall clock to `instant`. Monotonic time does not change. */
  set(instant: InstantInput): this {
    this.#wallMs = toInstantMs(instant);
    return this;
  }

  /** Moves both clocks forward by a non-negative duration (`"5m"` or milliseconds). */
  advance(duration: DurationInput): this {
    const ms = toDurationMs(duration);
    this.#wallMs = instantToMs(this.#wallMs + ms);
    this.#monotonicMs += ms;
    return this;
  }
}

/** The current instant from `clock` (default: the system clock) as a new `Date`. */
export function nowUtc(clock: Clock = systemClock): Date {
  return clock.now();
}

/** The current instant from `clock` (default: the system clock) as a canonical UTC timestamp. */
export function nowIso(clock: Clock = systemClock): IsoTimestamp {
  return toIso(clock.nowMs());
}

/**
 * A point in time after which something is no longer allowed: a gate that denies on timeout, an
 * expiring authorisation. It reads time only from the injected clock.
 *
 * Expiry is inclusive: at exactly `expiresAt` the deadline has passed (`isExpired()` is true and
 * `remainingMs()` is 0), so a boundary instant always falls on the denying side.
 */
export class Deadline {
  readonly #expiresAtMs: number;
  readonly #clock: Clock;

  constructor(expiresAt: InstantInput, clock: Clock = systemClock) {
    this.#expiresAtMs = toInstantMs(expiresAt);
    this.#clock = clock;
  }

  /** A deadline `duration` from the clock's current instant. */
  static after(duration: DurationInput, clock: Clock = systemClock): Deadline {
    return new Deadline(instantToMs(clock.nowMs() + toDurationMs(duration)), clock);
  }

  /** The expiry instant as a new `Date`. */
  get expiresAt(): Date {
    return new Date(this.#expiresAtMs);
  }

  /**
   * True once the clock reads `expiresAt` or later. Fails closed: a clock that returns something
   * other than a finite number (a broken custom `Clock`) counts as expired.
   */
  isExpired(): boolean {
    const now = this.#clock.nowMs();
    return !(Number.isFinite(now) && now < this.#expiresAtMs);
  }

  /** Milliseconds left before expiry, never negative; 0 whenever {@link isExpired} is true. */
  remainingMs(): number {
    return this.isExpired() ? 0 : this.#expiresAtMs - this.#clock.nowMs();
  }
}
