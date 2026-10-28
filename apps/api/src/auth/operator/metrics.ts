import { Counter, type Registry } from 'prom-client';

/** Why an operator credential was refused: bounded codes only, never a user, token or tenant value. */
export type OperatorRefusal = 'NOT_OPERATOR' | 'OPERATOR_MFA_REQUIRED';

export interface OperatorAuthMetrics {
  /** `operator_mfa_required_total`: a verified operator credential without the operator second factor. */
  readonly mfaRequired: () => void;
  /** `operator_auth_refused_total{reason}`: an operator-route request refused as not an operator. */
  readonly refused: (reason: OperatorRefusal) => void;
}

/** Operator-authentication counters on the app's registry (#838). */
export function createOperatorAuthMetrics(registry: Registry): OperatorAuthMetrics {
  const mfaRequired = new Counter({
    name: 'operator_mfa_required_total',
    help: 'Operator credentials refused because the operator second factor was not completed.',
    registers: [registry],
  });
  const refused = new Counter({
    name: 'operator_auth_refused_total',
    help: 'Requests to operator routes refused, by reason.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  return {
    mfaRequired: () => {
      mfaRequired.inc();
    },
    refused: (reason) => {
      refused.inc({ reason });
    },
  };
}
