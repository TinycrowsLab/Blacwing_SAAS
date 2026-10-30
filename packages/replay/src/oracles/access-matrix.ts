import { oracleParamsSchemas } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import type { OracleVerdict } from '../oracle.js';
import type { RoleAccess, SignalStore } from './signals.js';
import type { RawObservation } from '../engine.js';

/**
 * The `access_matrix` evaluator (F9, F16, AUTHLOGIC-002). The same request was replayed under the acting role and under
 * each comparison role. The verdict is a deterministic comparison, never a model's judgement: it fires only when the
 * binding expects the acting role to be denied and the observed access is an allow. Any missing or errored observation
 * (an expired or locked-out session, for example) is Suspected, never guessed.
 */

export const ACCESS_MATRIX_REASONS = {
  noAccessSignal: 'no_access_signal',
  missingObservation: 'missing_observation',
  duplicateObservation: 'duplicate_observation',
  sessionError: 'session_error',
  deniedAsExpected: 'denied_as_expected',
  allowedWhenDenied: 'allowed_when_denied',
  expectationNotDeny: 'expectation_not_deny',
} as const;

/** Audit event recorded when a comparison shows the acting role reaching a resource the matrix denies. */
export const ACCESS_MATRIX_AUDIT_EVENT = 'oracle.access_matrix.violation';

/** The one observed outcome for `role`. Returns a reason code instead when it is missing, duplicated or errored. */
function outcomeFor(
  rows: readonly RoleAccess[],
  role: string,
): { readonly outcome: 'allow' | 'deny' } | { readonly reason: string } {
  const matching = rows.filter((row) => row.role === role);
  const [row] = matching;
  if (row === undefined) return { reason: ACCESS_MATRIX_REASONS.missingObservation };
  if (matching.length > 1) return { reason: ACCESS_MATRIX_REASONS.duplicateObservation };
  if (row.outcome === 'error') return { reason: ACCESS_MATRIX_REASONS.sessionError };
  return { outcome: row.outcome };
}

export function accessMatrixEvaluator(signals: SignalStore) {
  return (observation: RawObservation, params: unknown): OracleVerdict => {
    const parsed = oracleParamsSchemas.access_matrix.safeParse(params);
    if (!parsed.success) throw new ValidationError('access_matrix params are invalid');
    const { actingRole, comparisonRoles, expected } = parsed.data;

    const rows = signals(observation.replayId)?.access;
    if (rows === undefined) return { matched: false, reason: ACCESS_MATRIX_REASONS.noAccessSignal };

    // Every role the binding names must have exactly one observed outcome, and none may have errored. A comparison
    // role that could not be observed means the difference cannot be stated, so the verdict is Suspected.
    const acting = outcomeFor(rows, actingRole);
    if ('reason' in acting) return { matched: false, reason: acting.reason };
    for (const role of comparisonRoles) {
      const comparison = outcomeFor(rows, role);
      if ('reason' in comparison) return { matched: false, reason: comparison.reason };
    }

    if (expected === 'allow') {
      return { matched: false, reason: ACCESS_MATRIX_REASONS.expectationNotDeny };
    }
    if (acting.outcome === 'allow') {
      return {
        matched: true,
        reason: ACCESS_MATRIX_REASONS.allowedWhenDenied,
        auditEvent: ACCESS_MATRIX_AUDIT_EVENT,
      };
    }
    return { matched: false, reason: ACCESS_MATRIX_REASONS.deniedAsExpected };
  };
}
