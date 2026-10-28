// Wraps every platform-operator BFF route (#838): an outage of Keycloak or Valkey becomes a retryable 503, anything
// else a body-less 500. The failure is logged by type only (no message, no token).

import { createLogger } from '@blackwing/logger';

import { getOperatorAuthRuntime, type OperatorAuthRuntime } from './runtime.js';
import { jsonResponse, unavailable } from '../auth/http.js';
import { IdpUnavailableError } from '../auth/oidc.js';
import { SessionStoreUnavailableError } from '../auth/session-store.js';

const HTTP_INTERNAL_ERROR = 500;

export async function handleOperator(
  fn: (runtime: OperatorAuthRuntime) => Promise<Response>,
): Promise<Response> {
  try {
    return await fn(getOperatorAuthRuntime());
  } catch (error) {
    if (error instanceof IdpUnavailableError || error instanceof SessionStoreUnavailableError) {
      return unavailable();
    }
    createLogger('operator-auth').error(
      { errorType: error instanceof Error ? error.name : typeof error },
      'operator_auth.handler_failed',
    );
    return jsonResponse({ error: 'internal' }, { status: HTTP_INTERNAL_ERROR });
  }
}
