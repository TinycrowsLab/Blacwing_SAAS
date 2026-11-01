import { newId } from '@blackwing/ids';

import { log, markSpanError, tracer } from './telemetry.js';

import type { OracleDispatcher } from './dispatch.js';
import type { RawObservation, ReplayEngine, RunOptions } from './engine.js';
import type { ReplaySpec } from '@blackwing/contracts';

/**
 * The confirm rule (#722, VALIDATE-011). A candidate is confirmable only when the positive replay fires the declared
 * oracle AND the negative control (an ordinary, benign variant of the same test) does not. Both replays run through the
 * same engine, so each gets a fresh sandbox with the same pins, and the same evaluator judges both observations.
 * The rule is a single boolean, `confirmable = positiveFired && negativeControlClean`, and it fails closed: any
 * uncertainty about the negative control means not confirmable. No model is involved (§8.11).
 */

/**
 * The replay spec as the caller holds it. The negative control is required by the contract, but the validator still
 * treats an absent or empty one as non-confirmable instead of dropping the candidate.
 */
export type NegativeControlSpec = Omit<ReplaySpec, 'negativeControl'> & {
  readonly negativeControl?: ReplaySpec['negativeControl'] | null;
};

/** The engine port: only `run` is needed, so tests can drive the real engine or a fake one. */
export type NegativeControlEngine = Pick<ReplayEngine, 'run'>;

/** Optional budget gate, checked before the negative control starts. An exhausted budget leaves it not run. */
export interface NegativeControlBudget {
  readonly hasRemaining: () => boolean;
}

export type NegativeControlAuditEvent =
  | {
      readonly type: 'validation.negative_control.run';
      readonly candidateId: string;
      readonly clean: boolean;
    }
  | {
      readonly type: 'validation.confirm_rule';
      readonly candidateId: string;
      readonly confirmable: boolean;
    };

export interface NegativeControlAudit {
  readonly record: (event: NegativeControlAuditEvent) => Promise<void>;
}

/** Metrics port: `negative_control_runs_total{clean}` and `confirm_rule_total{confirmable}`. Defaults to nothing. */
export interface NegativeControlMetrics {
  readonly negativeControlRun: (labels: { readonly clean: 'true' | 'false' }) => void;
  readonly confirmRule: (labels: { readonly confirmable: 'true' | 'false' }) => void;
}

export const noopNegativeControlMetrics: NegativeControlMetrics = {
  negativeControlRun: () => undefined,
  confirmRule: () => undefined,
};

export interface NegativeControlDeps {
  readonly engine: NegativeControlEngine;
  readonly dispatch: OracleDispatcher;
  readonly audit: NegativeControlAudit;
  readonly budget?: NegativeControlBudget;
  readonly metrics?: NegativeControlMetrics;
}

/** Why a candidate is not confirmable. Empty when it is. */
export type NegativeControlReason =
  | 'aborted'
  | 'positive_not_observed'
  | 'positive_not_fired'
  | 'positive_evaluator_error'
  | 'negative_control_missing'
  | 'negative_control_budget_exhausted'
  | 'negative_control_not_observed'
  | 'negative_control_error'
  | 'negative_control_fired';

export interface NegativeControlResult {
  readonly candidateId: string;
  readonly positiveFired: boolean;
  readonly negativeControlClean: boolean;
  readonly confirmable: boolean;
  /** `confirmed` only when `confirmable`. Otherwise `suspected`: the analyst-only queue. */
  readonly outcome: 'confirmed' | 'suspected';
  readonly reasons: readonly NegativeControlReason[];
  /** The positive observation, with its evidence references. */
  readonly positive: RawObservation;
  /** The negative-control observation. Absent when the control did not run to an observation. */
  readonly negative?: RawObservation;
}

const NEGATIVE_CONTROL_SPAN = 'validation.negctl';

interface NegativeOutcome {
  readonly clean: boolean;
  readonly reason?: NegativeControlReason;
  readonly observation?: RawObservation;
  /** True when the control actually ran (to an observation or an error), so a run event is due. */
  readonly ran: boolean;
}

/**
 * Replays `spec` positively and with its negative control, then applies the confirm rule. A positive refusal (scope,
 * authorisation, journal, sandbox) propagates, as {@link ReplayEngine.run} does, and the caller leaves the candidate
 * Suspected. Any failure of the negative control is recorded as a reason, never as a clean control.
 */
export async function runWithNegativeControl(
  spec: NegativeControlSpec,
  deps: NegativeControlDeps,
  options: RunOptions = {},
): Promise<NegativeControlResult> {
  return tracer.startActiveSpan(
    NEGATIVE_CONTROL_SPAN,
    async (span): Promise<NegativeControlResult> => {
      span.setAttribute('candidateId', spec.candidateId);
      try {
        // The engine reads only the steps, pins and oracle of a spec, never `negativeControl`, so the positive run
        // takes the spec as it is.
        const positive = await deps.engine.run(spec as ReplaySpec, options);
        const positiveVerdict = judgePositive(spec, deps, positive);
        const positiveFired = positiveVerdict.fired;
        const negative = await runNegativeControl(spec, deps, options);

        const reasons: NegativeControlReason[] = positiveFired
          ? []
          : [positiveReason(positive, positiveVerdict.evaluatorError)];
        if (negative.reason !== undefined) reasons.push(negative.reason);
        const confirmable = positiveFired && negative.clean;

        if (negative.ran) {
          deps.metrics?.negativeControlRun({ clean: negative.clean ? 'true' : 'false' });
          await deps.audit.record({
            type: 'validation.negative_control.run',
            candidateId: spec.candidateId,
            clean: negative.clean,
          });
        }
        deps.metrics?.confirmRule({ confirmable: confirmable ? 'true' : 'false' });
        await deps.audit.record({
          type: 'validation.confirm_rule',
          candidateId: spec.candidateId,
          confirmable,
        });
        span.setAttributes({ positiveFired, negativeControlClean: negative.clean, confirmable });
        log.info({ candidateId: spec.candidateId, confirmable, reasons }, 'confirm rule applied');

        return {
          candidateId: spec.candidateId,
          positiveFired,
          negativeControlClean: negative.clean,
          confirmable,
          outcome: confirmable ? 'confirmed' : 'suspected',
          reasons: confirmable ? [] : [...new Set(reasons)],
          positive,
          ...(negative.observation === undefined ? {} : { negative: negative.observation }),
        };
      } catch (error) {
        markSpanError(span, error instanceof Error ? error.name : 'unknown');
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Whether the oracle fired on the observation. Evaluated with the candidate's own declared oracle and params. */
function didFire(
  spec: NegativeControlSpec,
  deps: NegativeControlDeps,
  observation: RawObservation,
): boolean {
  return deps.dispatch(spec.oracle.type, observation, spec.oracle.params).matched;
}

/** The positive verdict. An evaluator error is not a fired oracle: it fails closed to not fired, with its own reason. */
function judgePositive(
  spec: NegativeControlSpec,
  deps: NegativeControlDeps,
  positive: RawObservation,
): { readonly fired: boolean; readonly evaluatorError: boolean } {
  if (positive.status !== 'completed') return { fired: false, evaluatorError: false };
  try {
    return { fired: didFire(spec, deps, positive), evaluatorError: false };
  } catch {
    return { fired: false, evaluatorError: true };
  }
}

function positiveReason(positive: RawObservation, evaluatorError: boolean): NegativeControlReason {
  if (positive.status === 'aborted') return 'aborted';
  if (positive.status !== 'completed') return 'positive_not_observed';
  return evaluatorError ? 'positive_evaluator_error' : 'positive_not_fired';
}

/**
 * Runs the negative control as its own replay: same oracle, same pins and same engine, but a fresh replay id (so its
 * evidence and journal entries are separate) and the control's steps. Every path that does not end in an observation
 * is not clean.
 */
async function runNegativeControl(
  spec: NegativeControlSpec,
  deps: NegativeControlDeps,
  options: RunOptions,
): Promise<NegativeOutcome> {
  const control = spec.negativeControl;
  if (control === null || control === undefined || control.steps.length === 0) {
    return { clean: false, reason: 'negative_control_missing', ran: false };
  }
  if (options.signal?.aborted === true) {
    return { clean: false, reason: 'aborted', ran: false };
  }
  if (deps.budget !== undefined && !deps.budget.hasRemaining()) {
    return { clean: false, reason: 'negative_control_budget_exhausted', ran: false };
  }

  const controlSpec: ReplaySpec = {
    ...spec,
    id: newId(),
    steps: [...control.steps],
    negativeControl: control,
  };
  let observation: RawObservation;
  try {
    observation = await deps.engine.run(controlSpec, options);
  } catch {
    return { clean: false, reason: 'negative_control_error', ran: true };
  }
  if (observation.status === 'aborted') {
    return { clean: false, reason: 'aborted', ran: true, observation };
  }
  if (observation.status !== 'completed') {
    return { clean: false, reason: 'negative_control_not_observed', ran: true, observation };
  }

  let fired: boolean;
  try {
    fired = didFire(spec, deps, observation);
  } catch {
    return { clean: false, reason: 'negative_control_error', ran: true, observation };
  }
  return fired
    ? { clean: false, reason: 'negative_control_fired', ran: true, observation }
    : { clean: true, ran: true, observation };
}
