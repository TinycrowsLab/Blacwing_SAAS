import {
  clearCookie,
  OPERATOR_SESSION_COOKIE,
  readCookie,
} from '../../../../../../lib/auth/cookies';
import {
  csrfValid,
  forbidden,
  jsonResponse,
  unauthenticated,
  unavailable,
} from '../../../../../../lib/auth/http';
import { handleOperator } from '../../../../../../lib/operator-auth/handler';
import { operatorSessionView } from '../../../../../../lib/operator-auth/session-view';

export const dynamic = 'force-dynamic';

/**
 * Renews the operator's tokens when they are about to expire (single-flight across tabs and replicas). A renewal the
 * IdP refuses, or one that no longer carries the second factor, ends the session: 401 and the cookie is cleared. Requires
 * the CSRF header.
 */
export function POST(request: Request): Promise<Response> {
  return handleOperator(async ({ service, config }) => {
    const cookie = readCookie(request.headers.get('cookie'), OPERATOR_SESSION_COOKIE);
    const state = await service.authenticate(cookie);
    if (state.status === 'unavailable') return unavailable();
    if (state.status !== 'ok') {
      return unauthenticated(cookie === undefined ? [] : [clearCookie(OPERATOR_SESSION_COOKIE)]);
    }
    if (!csrfValid(request, state.record, config.consoleOrigin)) return forbidden();
    return jsonResponse(operatorSessionView(state.record));
  });
}
