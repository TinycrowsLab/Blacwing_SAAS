import { logoutTokenOf } from '../../../../lib/auth/backchannel';
import { handle } from '../../../../lib/auth/handler';
import { badRequest, emptyResponse } from '../../../../lib/auth/http';

export const dynamic = 'force-dynamic';

const HTTP_OK = 200;

/**
 * Keycloak's back-channel logout (OIDC Back-Channel Logout 1.0, #336). Keycloak POSTs a signed logout
 * token here; the BFF sessions it names end at once, so the next request is sent to log in again. The
 * answer is 200 when the token is accepted (including when no session matched), 400 when it is refused,
 * and 503 while Keycloak or Valkey is down so Keycloak retries. No cookie or CSRF header is involved:
 * the signed token is the credential.
 */
export function POST(request: Request): Promise<Response> {
  return handle(async ({ service }) => {
    const result = await service.backchannelLogout(await logoutTokenOf(request));
    return result === 'success' ? emptyResponse(HTTP_OK) : badRequest();
  });
}
