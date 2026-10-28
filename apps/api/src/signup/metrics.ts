import { Counter, type Registry } from 'prom-client';

/** Signup metrics (TENANT-004). Alert on an abnormal `bw_signup_requested_total` rate. */
export interface SignupMetrics {
  /** `bw_signup_requested_total{result}`: `accepted` (mail sent), `throttled` (per-address limit), `email_failed`. */
  readonly requested: Counter<'result'>;
  /** `bw_signup_verified_total{outcome}`: `tenant_created` or `existing_account`. */
  readonly verified: Counter<'outcome'>;
  /** `bw_signup_token_invalid_total`: tokens that were unknown, expired, used or cancelled. */
  readonly tokenInvalid: Counter;
  /** `bw_signup_provisioning_enqueue_failures_total`: tenants committed whose Keycloak provisioning was not queued. */
  readonly provisioningFailures: Counter;
}

export function createSignupMetrics(registry: Registry): SignupMetrics {
  return {
    requested: new Counter({
      name: 'bw_signup_requested_total',
      help: 'Signup requests by result.',
      labelNames: ['result'],
      registers: [registry],
    }),
    verified: new Counter({
      name: 'bw_signup_verified_total',
      help: 'Verified signups by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    tokenInvalid: new Counter({
      name: 'bw_signup_token_invalid_total',
      help: 'Signup verification attempts with an unknown, expired, used or cancelled token.',
      registers: [registry],
    }),
    provisioningFailures: new Counter({
      name: 'bw_signup_provisioning_enqueue_failures_total',
      help: 'Tenants created by signup whose Keycloak Organization provisioning could not be queued.',
      registers: [registry],
    }),
  };
}
