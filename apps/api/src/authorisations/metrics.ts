import { Counter, type Registry } from 'prom-client';

/** The outcome of one submit call: `submitted` committed the transition, `refused` did not. */
export type SubmitResult = 'submitted' | 'refused';

/** Standing-authorisation metrics (AUTHZ-002 observability). Labels are bounded enums, never ids. */
export interface AuthorisationMetrics {
  submitted(result: SubmitResult): void;
}

/** `bw_authz_sa_submit_total{result}` on the app's registry. */
export function createAuthorisationMetrics(registry: Registry): AuthorisationMetrics {
  const counter = new Counter({
    name: 'bw_authz_sa_submit_total',
    help: 'Standing authorisation submit calls by result.',
    labelNames: ['result'],
    registers: [registry],
  });
  return {
    submitted: (result) => {
      counter.inc({ result });
    },
  };
}
