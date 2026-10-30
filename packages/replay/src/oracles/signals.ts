import type { OobHit } from '@blackwing/oob';

/**
 * The observed signals an oracle needs beyond the response bodies in the observation. The engine never measures
 * timing, never listens for callbacks and never sends a second role's request, so these are recorded by the
 * replay runner and looked up by the observation's `replayId`. Evaluators read them; they never fetch them live.
 */

/** Response times, in monotonic milliseconds, of the probe samples the runner timed. */
export interface TimingSignal {
  readonly probeMs: readonly number[];
}

/** Callbacks the listener recorded for this replay's per-test token. */
export interface OobSignal {
  readonly token: string;
  readonly interactions: readonly OobHit[];
}

/** The outcome of one role's request to the function under test. `error` covers an expired or locked session. */
export interface RoleAccess {
  readonly role: string;
  readonly outcome: 'allow' | 'deny' | 'error';
}

export interface ReplaySignals {
  readonly timing?: TimingSignal;
  readonly oob?: OobSignal;
  readonly access?: readonly RoleAccess[];
}

/** Resolves the signals recorded for one replay. `undefined` means nothing was recorded, which is never a match. */
export type SignalStore = (replayId: string) => ReplaySignals | undefined;
