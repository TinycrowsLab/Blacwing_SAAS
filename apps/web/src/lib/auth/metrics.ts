// Auth metrics and spans (IAM-002, #334) on the OpenTelemetry API: no-ops until the process registers
// an SDK. Labels are bounded reason codes; never a user, token or tenant value.

import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';

const NAME = '@blackwing/web';

export type LoginResult =
  | 'success'
  | 'invalid_state'
  | 'denied'
  | 'exchange_failed'
  | 'invalid_token'
  | 'no_tenant'
  | 'idp_unavailable'
  | 'store_unavailable';

export type RefreshResult =
  'success' | 'rejected' | 'no_refresh_token' | 'invalid_token' | 'idp_unavailable' | 'busy';

/** Outcome of a back-channel logout request (#336). */
export type BackchannelResult = 'success' | 'invalid_token' | 'replayed' | 'unavailable';

/** What a revocation targeted (#336). */
type RevocationScope = 'user' | 'tenant' | 'user_tenant' | 'backchannel';

export interface AuthMetrics {
  login(result: LoginResult): void;
  refresh(result: RefreshResult): void;
  logout(): void;
  backchannelLogout(result: BackchannelResult): void;
  sessionRevocation(scope: RevocationScope): void;
}

export function createAuthMetrics(): AuthMetrics {
  const meter = metrics.getMeter(NAME);
  const login = meter.createCounter('auth_login_total', { description: 'OIDC logins by result.' });
  const refresh = meter.createCounter('auth_refresh_total', {
    description: 'Token refreshes by result.',
  });
  const logout = meter.createCounter('auth_logout_total', { description: 'Logouts.' });
  const backchannel = meter.createCounter('backchannel_logout_total', {
    description: 'Keycloak back-channel logout requests by result.',
  });
  const revocations = meter.createCounter('session_revocations_total', {
    description: 'Session revocations by scope.',
  });
  return {
    login: (result) => {
      login.add(1, { result });
    },
    refresh: (result) => {
      refresh.add(1, { result });
    },
    logout: () => {
      logout.add(1);
    },
    backchannelLogout: (result) => {
      backchannel.add(1, { result });
    },
    sessionRevocation: (scope) => {
      revocations.add(1, { scope });
    },
  };
}

/** Runs `fn` in a span named `name`; an exception marks the span failed and is rethrown. */
export async function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
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
