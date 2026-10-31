import { ValidationError } from '@blackwing/errors';

import type { RawObservation, ReplayExchange } from '../engine.js';
import type { OracleVerdict } from '../oracle.js';

/**
 * Helpers shared by the deterministic oracle evaluators (VALIDATE-004). Evaluators are pure: they read the recorded
 * observation and the declared params, and never perform I/O, read the clock or call a model (§8.11).
 */

/**
 * The exchange an oracle inspects: the last executed step, which is the probe under test. A step with no status
 * (a TCP probe, or a transport failure) is not an observation, so it yields `undefined`.
 */
export function probeExchange(observation: RawObservation): ReplayExchange | undefined {
  const exchange = observation.exchanges.at(-1);
  return exchange?.status === null || exchange === undefined ? undefined : exchange;
}

/** Nothing was observed for this probe, so there is nothing to judge. The candidate stays Suspected. */
export const NO_OBSERVATION: OracleVerdict = { matched: false, reason: 'no_observation' };

/** The declared params do not match the oracle's contract. Malformed input never fires an oracle. */
export const INVALID_PARAMS: OracleVerdict = { matched: false, reason: 'invalid_params' };

/**
 * A differential cannot be judged without its recorded baseline: the baseline is missing, was not recorded before the
 * probe, or has no status. The error keeps the candidate Suspected.
 */
export class OracleBaselineMissingError extends ValidationError {
  constructor() {
    super('a differential oracle needs a recorded baseline observation');
  }
}

/** NFC-normalises text before any comparison, so canonically equal Unicode strings compare equal. */
export function nfc(text: string): string {
  return text.normalize('NFC');
}

/** True for a plain object, so a non-object params value is refused without property access. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
