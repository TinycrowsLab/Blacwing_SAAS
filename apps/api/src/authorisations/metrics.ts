import { Counter, type Registry } from 'prom-client';

/** The outcome of one submit call: `submitted` committed the transition, `refused` did not. */
export type SubmitResult = 'submitted' | 'refused';

/** The outcome of one approve or reject call: `refused` committed nothing. */
export type ApprovalResult = 'approved' | 'rejected' | 'refused';

/** Standing-authorisation metrics (AUTHZ-002, AUTHZ-008 observability). Labels are bounded enums, never ids. */
export interface AuthorisationMetrics {
  submitted(result: SubmitResult): void;
  /** `bw_authz_sa_approvals_total{result,auto}`: `auto` is `false` until the POLICY auto-approval lands. */
  approval(result: ApprovalResult): void;
}

/** `bw_authz_sa_submit_total{result}` on the app's registry. */
export function createAuthorisationMetrics(registry: Registry): AuthorisationMetrics {
  const counter = new Counter({
    name: 'bw_authz_sa_submit_total',
    help: 'Standing authorisation submit calls by result.',
    labelNames: ['result'],
    registers: [registry],
  });
  const approvals = new Counter({
    name: 'bw_authz_sa_approvals_total',
    help: 'Standing authorisation approve and reject calls by result.',
    labelNames: ['result', 'auto'],
    registers: [registry],
  });
  return {
    submitted: (result) => {
      counter.inc({ result });
    },
    approval: (result) => {
      approvals.inc({ result, auto: 'false' });
    },
  };
}
