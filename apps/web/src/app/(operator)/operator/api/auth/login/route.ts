import { serializeCookie, OPERATOR_LOGIN_COOKIE } from '../../../../../../lib/auth/cookies';
import { redirectResponse } from '../../../../../../lib/auth/http';
import { handleOperator } from '../../../../../../lib/operator-auth/handler';
import { OPERATOR_LOGIN_TTL_MS } from '../../../../../../lib/operator-auth/service';

export const dynamic = 'force-dynamic';

const MS_PER_SECOND = 1000;

/**
 * Starts the platform-operator Authorization Code + PKCE (S256) flow against the `blackwing-operators` realm (#838).
 * State, nonce and the verifier go into a short-lived sealed cookie; the browser goes to Keycloak.
 */
export function GET(request: Request): Promise<Response> {
  return handleOperator(async ({ service }) => {
    const returnTo = new URL(request.url).searchParams.get('returnTo');
    const { location, loginCookie } = await service.startLogin(returnTo);
    return redirectResponse(location, {
      status: 302,
      cookies: [
        serializeCookie(OPERATOR_LOGIN_COOKIE, loginCookie, OPERATOR_LOGIN_TTL_MS / MS_PER_SECOND),
      ],
    });
  });
}
