import { Counter, type Registry } from 'prom-client';

import type { SubmitErrorCode } from '@blackwing/contracts';

/** Scoping-form metrics (SCOPE-005 observability). Labels are closed sets: the result and the check code. */
export interface AssessmentRequestMetrics {
  /** One submit attempt, by outcome: `submitted`, `validation_failed` or `halted`. */
  submitted(result: 'submitted' | 'validation_failed' | 'halted'): void;
  /** One failing check of a submit, counted by its stable code. */
  validationFailed(code: SubmitErrorCode): void;
}

/** `scope_request_submit_total{result}` and `scope_submit_validation_failures_total{code}` on the app's registry. */
export function createAssessmentRequestMetrics(registry: Registry): AssessmentRequestMetrics {
  const submits = new Counter({
    name: 'scope_request_submit_total',
    help: 'Assessment request submit attempts by result.',
    labelNames: ['result'],
    registers: [registry],
  });
  const failures = new Counter({
    name: 'scope_submit_validation_failures_total',
    help: 'Failing checks of an assessment request submit, by code.',
    labelNames: ['code'],
    registers: [registry],
  });
  return {
    submitted: (result) => {
      submits.inc({ result });
    },
    validationFailed: (code) => {
      failures.inc({ code });
    },
  };
}
