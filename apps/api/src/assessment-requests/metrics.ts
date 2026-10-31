import { Counter, Histogram, exponentialBuckets, type Registry } from 'prom-client';

import type { SubmitErrorCode } from '@blackwing/contracts';
import type { PreflightStatus } from '@blackwing/domain';

/** Scoping-form metrics (SCOPE-005 observability, #579 dry run). Labels are closed sets: results, codes and ids. */
export interface AssessmentRequestMetrics {
  /** One submit attempt, by outcome: `submitted`, `validation_failed` or `halted`. */
  submitted(result: 'submitted' | 'validation_failed' | 'halted'): void;
  /** One failing check of a submit, counted by its stable code. */
  validationFailed(code: SubmitErrorCode): void;
  /** One dry-run check's answer and how long it took, in seconds. */
  preflightCheck(id: string, status: PreflightStatus, seconds: number): void;
  /** One completed dry run, by verdict. */
  preflightDryRun(ok: boolean): void;
}

/**
 * `scope_request_submit_total{result}`, `scope_submit_validation_failures_total{code}`,
 * `preflight_check_total{id,status}`, `preflight_check_duration_seconds{id}` and `preflight_dry_run_total{ok}` on the
 * app's registry.
 */
/** Dry-run check duration buckets in seconds: 5 ms doubling, eleven buckets (5 ms to 5.12 s), the check timeout. */
const CHECK_FIRST_BUCKET_SECONDS = 0.005;
const CHECK_BUCKET_FACTOR = 2;
const CHECK_BUCKET_COUNT = 11;
const CHECK_DURATION_BUCKETS_SECONDS = exponentialBuckets(
  CHECK_FIRST_BUCKET_SECONDS,
  CHECK_BUCKET_FACTOR,
  CHECK_BUCKET_COUNT,
);

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
  const checks = new Counter({
    name: 'preflight_check_total',
    help: 'Pre-submit dry-run preflight checks by check id and status.',
    labelNames: ['id', 'status'],
    registers: [registry],
  });
  const checkDuration = new Histogram({
    name: 'preflight_check_duration_seconds',
    help: 'Duration of one pre-submit dry-run preflight check, by check id.',
    labelNames: ['id'],
    buckets: CHECK_DURATION_BUCKETS_SECONDS,
    registers: [registry],
  });
  const dryRuns = new Counter({
    name: 'preflight_dry_run_total',
    help: 'Completed pre-submit dry runs by verdict.',
    labelNames: ['ok'],
    registers: [registry],
  });
  return {
    submitted: (result) => {
      submits.inc({ result });
    },
    validationFailed: (code) => {
      failures.inc({ code });
    },
    preflightCheck: (id, status, seconds) => {
      checks.inc({ id, status });
      checkDuration.observe({ id }, seconds);
    },
    preflightDryRun: (ok) => {
      dryRuns.inc({ ok: ok ? 'true' : 'false' });
    },
  };
}
