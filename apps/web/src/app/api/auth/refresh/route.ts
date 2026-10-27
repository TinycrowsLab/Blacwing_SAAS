import { clearCookie, readCookie, SESSION_COOKIE } from '../../../../lib/auth/cookies';
import { handle } from '../../../../lib/auth/handler';
import {
  csrfValid,
  forbidden,
  jsonResponse,
  unauthenticated,
  unavailable,
} from '../../../../lib/auth/http';
import { sessionResponse } from '../../../../lib/auth/session-response';

export const dynamic = 'force-dynamic';

/**
 * Renews the tokens held for this session when they are about to expire (single-flight across tabs
 * and replicas). A refresh the IdP refuses ends the session: 401 and the cookie is cleared, so the
 * page sends the user back through login. Requires the CSRF header.
 */
export function POST(request: Request): Promise<Response> {
  return handle(async ({ service, config }) => {
    const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const state = await service.authenticate(cookie);
    if (state.status === 'unavailable') return unavailable();
    if (state.status !== 'ok') {
      return unauthenticated(cookie === undefined ? [] : [clearCookie(SESSION_COOKIE)]);
    }
    if (!csrfValid(request, state.record, config.consoleOrigin)) return forbidden();
    return jsonResponse(sessionResponse(state.record));
  });
}
