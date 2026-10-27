// Wraps every BFF route handler (IAM-002, #334): an outage of Keycloak or Valkey becomes a retryable
// 503, anything else a body-less 500. The failure is logged by type only (no message, no token).

import { createLogger } from '@blackwing/logger';

import { jsonResponse, unavailable } from './http.js';
import { IdpUnavailableError } from './oidc.js';
import { getAuthRuntime, type AuthRuntime } from './runtime.js';
import { SessionStoreUnavailableError } from './session-store.js';

const HTTP_INTERNAL_ERROR = 500;

export async function handle(fn: (runtime: AuthRuntime) => Promise<Response>): Promise<Response> {
  try {
    return await fn(getAuthRuntime());
  } catch (error) {
    if (error instanceof IdpUnavailableError || error instanceof SessionStoreUnavailableError) {
      return unavailable();
    }
    createLogger('web-auth').error(
      { errorType: error instanceof Error ? error.name : typeof error },
      'auth.handler_failed',
    );
    return jsonResponse({ error: 'internal' }, { status: HTTP_INTERNAL_ERROR });
  }
}
