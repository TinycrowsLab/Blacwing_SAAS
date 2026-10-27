import { z } from 'zod';

import {
  clearCookie,
  LOGIN_COOKIE,
  readCookie,
  SESSION_COOKIE,
  serializeCookie,
} from '../../../../lib/auth/cookies';
import { handle } from '../../../../lib/auth/handler';
import { redirectResponse } from '../../../../lib/auth/http';

export const dynamic = 'force-dynamic';

const MAX_PARAM_LENGTH = 2048;
const param = z.string().min(1).max(MAX_PARAM_LENGTH).optional();
const querySchema = z.object({ code: param, state: param, error: param });

/**
 * Keycloak's redirect target. Validates state, exchanges the code server-side with the PKCE verifier,
 * verifies the ID token and only then creates the session. Any failure lands on `/login?error=<reason>`
 * where the user can retry; no session exists unless every step passed.
 */
export function GET(request: Request): Promise<Response> {
  return handle(async ({ service, config }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    const outcome = await service.completeLogin({
      code: query.success ? query.data.code : undefined,
      state: query.success ? query.data.state : undefined,
      idpError: query.success ? query.data.error : undefined,
      loginCookie: readCookie(request.headers.get('cookie'), LOGIN_COOKIE),
    });
    const consumed = clearCookie(LOGIN_COOKIE);
    if (!outcome.ok) {
      return redirectResponse(`${config.consoleOrigin}/login?error=${outcome.reason}`, {
        cookies: [consumed],
      });
    }
    return redirectResponse(`${config.consoleOrigin}${outcome.returnTo}`, {
      cookies: [consumed, serializeCookie(SESSION_COOKIE, outcome.sessionCookie)],
    });
  });
}
