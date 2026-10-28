import {
  clearCookie,
  OPERATOR_SESSION_COOKIE,
  readCookie,
} from '../../../../../../lib/auth/cookies';
import { csrfValid, forbidden, jsonResponse, unavailable } from '../../../../../../lib/auth/http';
import { handleOperator } from '../../../../../../lib/operator-auth/handler';

export const dynamic = 'force-dynamic';

/**
 * Ends the operator session here (the server-side record is deleted, the cookie cleared) and answers with the operator
 * realm's end-session URL for the page to navigate to. A session that is already gone is not an error. Requires the
 * CSRF header while the session exists.
 */
export function POST(request: Request): Promise<Response> {
  return handleOperator(async ({ service, config }) => {
    const cookie = readCookie(request.headers.get('cookie'), OPERATOR_SESSION_COOKIE);
    const state = await service.authenticate(cookie, false);
    if (state.status === 'unavailable') return unavailable();
    if (state.status === 'ok' && !csrfValid(request, state.record, config.consoleOrigin)) {
      return forbidden();
    }
    const { redirectTo } = await service.logout(cookie);
    return jsonResponse({ redirectTo }, { cookies: [clearCookie(OPERATOR_SESSION_COOKIE)] });
  });
}
