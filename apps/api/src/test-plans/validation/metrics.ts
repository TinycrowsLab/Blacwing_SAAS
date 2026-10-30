import { Counter, type Registry } from 'prom-client';

import type { PlanValidationResult } from '@blackwing/contracts';

/** The outcome label of `plan_validation_total`: a valid plan, an invalid one, or an evaluation that failed. */
export type PlanValidationOutcome = 'valid' | 'invalid' | 'error';

export interface PlanValidationMetrics {
  /** Counts one completed validation (`valid`, `invalid`) or one that could not complete (`error`). */
  validated(result: PlanValidationOutcome): void;
  /** Counts each violation of a completed validation by its code. */
  violations(result: PlanValidationResult): void;
}

/**
 * `plan_validation_total{result}` and `plan_validation_violations{code}` on the app's registry. Both label sets are
 * closed (the outcomes and `PLAN_VIOLATION_CODES`), so cardinality is bounded.
 */
export function createPlanValidationMetrics(registry: Registry): PlanValidationMetrics {
  const total = new Counter({
    name: 'plan_validation_total',
    help: 'Test plan validations, by outcome.',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const byCode = new Counter({
    name: 'plan_validation_violations',
    help: 'Violations found by test plan validation, by code.',
    labelNames: ['code'] as const,
    registers: [registry],
  });
  return {
    validated(result) {
      total.inc({ result });
    },
    violations(validation) {
      for (const item of validation.violations) byCode.inc({ code: item.code });
    },
  };
}
