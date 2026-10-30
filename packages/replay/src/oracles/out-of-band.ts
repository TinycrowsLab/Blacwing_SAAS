import { oracleParamsSchemas } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';
import { correlateInteraction, OOB_CORRELATION_WINDOW_MAX_MS } from '@blackwing/oob';

import type { OracleVerdict } from '../oracle.js';
import type { SignalStore } from './signals.js';
import type { RawObservation } from '../engine.js';

/**
 * The `oob` evaluator (F15, CWE-918/CWE-89/CWE-611, WSTG-INPV). It fires only on an interaction that correlates to this
 * test's own per-test token, on the declared channel, inside the declared window measured from the probe send. An
 * uncorrelated, late or wrong-channel callback never fires. The listener itself lives in packages/oob, not here.
 */

export const OOB_REASONS = {
  noOobSignal: 'no_oob_signal',
  correlated: 'correlated_interaction',
  noCorrelatedInteraction: 'no_correlated_interaction',
} as const;

/** Audit event recorded when a correlated callback fires the oracle (§8 audit trail). */
export const OOB_AUDIT_EVENT = 'oracle.oob.correlated';

export function oobEvaluator(signals: SignalStore) {
  return (observation: RawObservation, params: unknown): OracleVerdict => {
    const parsed = oracleParamsSchemas.oob.safeParse(params);
    if (!parsed.success) throw new ValidationError('oob params are invalid');
    const { channel, windowMs } = parsed.data;
    if (windowMs > OOB_CORRELATION_WINDOW_MAX_MS) {
      throw new ValidationError('oob window exceeds the correlation limit');
    }

    const oob = signals(observation.replayId)?.oob;
    if (oob === undefined) return { matched: false, reason: OOB_REASONS.noOobSignal };

    const hit = correlateInteraction({
      token: oob.token,
      channel,
      windowMs,
      interactions: oob.interactions,
    });
    return hit === undefined
      ? { matched: false, reason: OOB_REASONS.noCorrelatedInteraction }
      : { matched: true, reason: OOB_REASONS.correlated, auditEvent: OOB_AUDIT_EVENT };
  };
}
