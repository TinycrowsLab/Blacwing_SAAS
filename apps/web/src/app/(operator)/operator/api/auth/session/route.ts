import {
  clearCookie,
  OPERATOR_SESSION_COOKIE,
  readCookie,
} from '../../../../../../lib/auth/cookies';
import { jsonResponse, unauthenticated, unavailable } from '../../../../../../lib/auth/http';
import { handleOperator } from '../../../../../../lib/operator-auth/handler';
import { operatorSessionView } from '../../../../../../lib/operator-auth/session-view';

export const dynamic = 'force-dynamic';

/**
 * whoami for the operator console (#838): the operator's public identity, roles, the CSRF token for mutations and when
 * the access token expires. Silently renews the tokens when they are about to expire. Never returns a token.
 */
export function GET(request: Request): Promise<Response> {
  return handleOperator(async ({ service }) => {
    const cookie = readCookie(request.headers.get('cookie'), OPERATOR_SESSION_COOKIE);
    const state = await service.authenticate(cookie);
    if (state.status === 'ok') return jsonResponse(operatorSessionView(state.record));
    if (state.status === 'unavailable') return unavailable();
    return unauthenticated(cookie === undefined ? [] : [clearCookie(OPERATOR_SESSION_COOKIE)]);
  });
}
