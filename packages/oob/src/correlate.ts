import { ValidationError } from '@blackwing/errors';

/**
 * Out-of-band interaction correlation (F15, interactsh pattern, REFERENCES §7). A listener records every inbound
 * DNS, HTTP or SMTP hit it receives. A hit counts for a test only when it carries that test's own per-test
 * token and arrives inside the window measured from the probe send. Everything else is uncorrelated and is
 * ignored, so an unrelated or late hit can never confirm a finding (§8.11, deterministic verdicts).
 */

export const OOB_CHANNELS = ['dns', 'http', 'smtp'] as const;
export type OobChannel = (typeof OOB_CHANNELS)[number];

/** One interaction as the listener recorded it. `offsetMs` is its arrival, measured from the probe send. */
export interface OobHit {
  readonly token: string;
  readonly channel: OobChannel;
  readonly offsetMs: number;
}

export interface CorrelationQuery {
  /** The per-test token the probe embedded. Only an exact match correlates. */
  readonly token: string;
  readonly channel: OobChannel;
  /** Longest arrival offset, from the probe send, that still counts. */
  readonly windowMs: number;
  readonly interactions: readonly OobHit[];
}

/** Longest window a correlation may use. Matches the binding contract's `OOB_WINDOW_MAX_MS`. */
export const OOB_CORRELATION_WINDOW_MAX_MS = 300_000;

/**
 * Returns the earliest interaction that correlates with the query, or `undefined`. An interaction correlates when
 * its token equals the query token exactly, its channel is the declared channel and its arrival offset lies in
 * `[0, windowMs]`. Hits that arrive before the probe (negative offsets) or after the window are not counted.
 */
export function correlateInteraction(query: CorrelationQuery): OobHit | undefined {
  if (
    !Number.isInteger(query.windowMs) ||
    query.windowMs < 1 ||
    query.windowMs > OOB_CORRELATION_WINDOW_MAX_MS
  ) {
    throw new ValidationError('an out-of-band correlation window must be 1 to 300000 ms');
  }
  let earliest: OobHit | undefined;
  for (const interaction of query.interactions) {
    if (interaction.token !== query.token) continue;
    if (interaction.channel !== query.channel) continue;
    if (!Number.isFinite(interaction.offsetMs)) continue;
    if (interaction.offsetMs < 0 || interaction.offsetMs > query.windowMs) continue;
    if (earliest === undefined || interaction.offsetMs < earliest.offsetMs) earliest = interaction;
  }
  return earliest;
}
