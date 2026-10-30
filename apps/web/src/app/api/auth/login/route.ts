import { LOGIN_COOKIE, serializeCookie } from '../../../../lib/auth/cookies';
import { handle } from '../../../../lib/auth/handler';
import { redirectResponse } from '../../../../lib/auth/http';
import { idpHintOf } from '../../../../lib/auth/idp-hint';
import { LOGIN_TTL_MS } from '../../../../lib/auth/service';

export const dynamic = 'force-dynamic';

const MS_PER_SECOND = 1000;

/**
 * Starts the OIDC Authorization Code + PKCE (S256) flow: state, nonce and the code verifier go into
 * a short-lived sealed cookie, the browser goes to Keycloak. `returnTo` must be an internal path.
 * `idp` (optional) starts a brokered provider directly; only allow-listed values (`google`) are used, others are ignored.
 */
export function GET(request: Request): Promise<Response> {
  return handle(async ({ service }) => {
    const params = new URL(request.url).searchParams;
    const returnTo = params.get('returnTo');
    const { location, loginCookie } = await service.startLogin(
      returnTo,
      idpHintOf(params.get('idp')),
    );
    return redirectResponse(location, {
      status: 302,
      cookies: [serializeCookie(LOGIN_COOKIE, loginCookie, LOGIN_TTL_MS / MS_PER_SECOND)],
    });
  });
}
