import { AppError, type AppErrorOptions } from '@blackwing/errors';

import type { VerificationStatus } from '@blackwing/contracts';

/**
 * Asset ownership-verification state machine (ASSET-003, CONTEXT_PACK §8.10).
 *
 * Pure: it takes values and returns values. The clock and the probes live in the service, which passes `now` in and
 * persists the result inside one tenant transaction (with the audit event, §8.8).
 *
 *   unverified --start--> pending --pass--> verified
 *                           |  ^--restart--+ (new token, budget reset)
 *                           +--fail / expire / cancel--> unverified
 *                           +--reject--> rejected
 *
 * `verified` and `rejected` are not left by this machine: re-verification is ASSET-008 and a manual rejection is
 * ASSET-007. Only a verified asset may be targeted (§8.10), so every path into `verified` runs through `pass`.
 */

/** Every event the verification lifecycle accepts. */
export const VERIFICATION_EVENT_TYPES = [
  'start',
  'restart',
  'pass',
  'fail',
  'expire',
  'cancel',
  'reject',
] as const;
export type VerificationEventType = (typeof VERIFICATION_EVENT_TYPES)[number];

/** The single source of truth for legal transitions: `VERIFICATION_TRANSITIONS[event]` names source and target. */
export const VERIFICATION_TRANSITIONS: Readonly<
  Record<
    VerificationEventType,
    { readonly from: VerificationStatus; readonly to: VerificationStatus }
  >
> = Object.freeze({
  start: { from: 'unverified', to: 'pending' },
  restart: { from: 'pending', to: 'pending' },
  pass: { from: 'pending', to: 'verified' },
  fail: { from: 'pending', to: 'unverified' },
  expire: { from: 'pending', to: 'unverified' },
  cancel: { from: 'pending', to: 'unverified' },
  reject: { from: 'pending', to: 'rejected' },
});

/** Raised when the machine refuses an event from the current status. `ASSET_VERIFICATION_ILLEGAL_TRANSITION` (409). */
export class IllegalVerificationTransitionError extends AppError {
  declare readonly code: 'ASSET_VERIFICATION_ILLEGAL_TRANSITION';
  /** Status the asset was in. */
  readonly from: string;
  /** Event that was refused. */
  readonly eventType: string;

  constructor(from: string, eventType: string, options: AppErrorOptions = {}) {
    super(
      'ASSET_VERIFICATION_ILLEGAL_TRANSITION',
      `Illegal asset verification transition: ${from} on ${eventType}`,
      {
        detail: `An asset cannot "${eventType}" from "${from}" in its verification.`,
        ...options,
      },
    );
    this.from = from;
    this.eventType = eventType;
  }
}

/** The status `event` leads to from `from`. Throws `IllegalVerificationTransitionError` for any other pair. */
export function transitionVerification(
  from: VerificationStatus,
  event: VerificationEventType,
): VerificationStatus {
  const rule = Object.hasOwn(VERIFICATION_TRANSITIONS, event)
    ? VERIFICATION_TRANSITIONS[event]
    : undefined;
  if (rule?.from !== from) {
    throw new IllegalVerificationTransitionError(from, event);
  }
  return rule.to;
}

/** A challenge is expired from the instant of `expiresAt` on (UTC epoch arithmetic, so DST cannot shift it). */
export function isChallengeExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * MS_PER_SECOND;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

/** `now` plus `hours` (UTC). */
export function addHours(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * MS_PER_HOUR);
}

/** `now` plus `days` (UTC). */
export function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * MS_PER_DAY);
}

/** What a probe run leads to: the asset is verified, the challenge stays open for another check, or it is spent. */
export type ProbeDecision = 'passed' | 'retry' | 'exhausted';

/**
 * The decision after one more probe run. `attemptsAfter` is the attempt count including this run. A pass always
 * wins; a miss keeps the challenge open until the attempt budget (`maxCheckAttempts`) is spent.
 */
export function decideAfterProbe(
  passed: boolean,
  attemptsAfter: number,
  maxCheckAttempts: number,
): ProbeDecision {
  if (passed) return 'passed';
  return attemptsAfter >= maxCheckAttempts ? 'exhausted' : 'retry';
}
