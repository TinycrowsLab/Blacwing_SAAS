import { ValidationError } from '@blackwing/errors';

import type { RawObservation, ReplayStatus } from './engine.js';
import type { OracleVerdict } from './oracle.js';

/**
 * Routes a replay observation to the evaluator registered for its oracle type. The engine never evaluates, so
 * this is the only place a verdict is chosen. An unregistered type fails closed: the caller treats the
 * candidate as Suspected, never Confirmed (§8.11).
 */

/** Refuses an oracle type with no registered evaluator. The type is untrusted input, so it is not echoed. */
export class UnknownOracleError extends ValidationError {
  constructor() {
    super('no evaluator is registered for this oracle type');
  }
}

/** Evaluates one observation against the typed params of its oracle binding. */
export type OracleEvaluator = (observation: RawObservation, params: unknown) => OracleVerdict;

/**
 * A verdict, or, when nothing was observed, the reason it is Suspected. `suspectedReason` is set only for a
 * non-`completed` observation, and the evaluator is then not called.
 */
export interface DispatchOutcome extends OracleVerdict {
  readonly suspectedReason?: Exclude<ReplayStatus, 'completed'>;
}

export type OracleDispatcher = (
  oracleType: string,
  observation: RawObservation,
  params: unknown,
) => DispatchOutcome;

/**
 * Builds the router over `evaluators`, keyed by oracle type. A `Map` is used so a type such as `toString` or
 * `__proto__` is never found by prototype lookup.
 */
export function createOracleDispatcher(
  evaluators: ReadonlyMap<string, OracleEvaluator>,
): OracleDispatcher {
  return (oracleType, observation, params) => {
    const evaluator = evaluators.get(oracleType);
    if (evaluator === undefined) throw new UnknownOracleError();
    if (observation.status !== 'completed') {
      return { matched: false, suspectedReason: observation.status };
    }
    return evaluator(observation, params);
  };
}
