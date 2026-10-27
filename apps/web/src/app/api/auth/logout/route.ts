import { clearCookie, readCookie, SESSION_COOKIE } from '../../../../lib/auth/cookies';
import { handle } from '../../../../lib/auth/handler';
import { csrfValid, forbidden, jsonResponse, unavailable } from '../../../../lib/auth/http';

export const dynamic = 'force-dynamic';

/**
 * Ends the session here (the server-side record is deleted, the cookie cleared) and answers with the
 * Keycloak end-session URL (RP-initiated logout) for the page to navigate to. A session that is already
 * gone is not an error. Requires the CSRF header while the session exists.
 */
export function POST(request: Request): Promise<Response> {
  return handle(async ({ service, config }) => {
    const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const state = await service.authenticate(cookie, false);
    if (state.status === 'unavailable') return unavailable();
    if (state.status === 'ok' && !csrfValid(request, state.record, config.consoleOrigin)) {
      return forbidden();
    }
    const { redirectTo } = await service.logout(cookie);
    return jsonResponse({ redirectTo }, { cookies: [clearCookie(SESSION_COOKIE)] });
  });
}
