// Platform-operator auth metrics and spans (#838) on the OpenTelemetry API: no-ops until the process registers an
// SDK. Labels are bounded reason codes; never an operator, token or tenant value.

import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const NAME = '@blackwing/web';

export type OperatorLoginResult =
  | 'success'
  | 'invalid_state'
  | 'denied'
  | 'exchange_failed'
  | 'invalid_token'
  | 'mfa_required'
  | 'not_operator'
  | 'idp_unavailable'
  | 'store_unavailable';

export type OperatorRefreshResult =
  | 'success'
  | 'rejected'
  | 'no_refresh_token'
  | 'invalid_token'
  | 'mfa_lost'
  | 'not_operator'
  | 'idp_unavailable'
  | 'busy';

export interface OperatorAuthMetrics {
  login(result: OperatorLoginResult): void;
  refresh(result: OperatorRefreshResult): void;
  /** A sign-in or renewal whose token lacked the operator second factor (`operator_mfa_required_total`). */
  mfaRequired(): void;
  logout(): void;
}

export function createOperatorAuthMetrics(): OperatorAuthMetrics {
  const meter = metrics.getMeter(NAME);
  const login = meter.createCounter('operator_auth_login_total', {
    description: 'Platform-operator sign-ins by result.',
  });
  const refresh = meter.createCounter('operator_auth_refresh_total', {
    description: 'Platform-operator token refreshes by result.',
  });
  const mfaRequired = meter.createCounter('operator_mfa_required_total', {
    description: 'Platform-operator sessions refused for a missing second factor.',
  });
  const logout = meter.createCounter('operator_auth_logout_total', {
    description: 'Platform-operator logouts.',
  });
  return {
    login: (result) => {
      login.add(1, { result });
    },
    refresh: (result) => {
      refresh.add(1, { result });
    },
    mfaRequired: () => {
      mfaRequired.add(1);
    },
    logout: () => {
      logout.add(1);
    },
  };
}

/** Runs `fn` in a span named `name`; an exception marks the span failed and is rethrown. */
export async function inOperatorSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer(NAME).startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
