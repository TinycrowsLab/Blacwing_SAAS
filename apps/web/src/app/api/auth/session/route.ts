import { clearCookie, readCookie, SESSION_COOKIE } from '../../../../lib/auth/cookies';
import { handle } from '../../../../lib/auth/handler';
import { jsonResponse, unauthenticated, unavailable } from '../../../../lib/auth/http';
import { sessionResponse } from '../../../../lib/auth/session-response';

export const dynamic = 'force-dynamic';

/**
 * whoami: the public identity, the CSRF token for mutations and when the access token expires.
 * Silently renews the tokens when they are about to expire. Never returns a token.
 */
export function GET(request: Request): Promise<Response> {
  return handle(async ({ service }) => {
    const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const state = await service.authenticate(cookie);
    if (state.status === 'ok') return jsonResponse(sessionResponse(state.record));
    if (state.status === 'unavailable') return unavailable();
    return unauthenticated(cookie === undefined ? [] : [clearCookie(SESSION_COOKIE)]);
  });
}
