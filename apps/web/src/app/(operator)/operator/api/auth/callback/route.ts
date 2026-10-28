import { z } from 'zod';

import {
  clearCookie,
  OPERATOR_LOGIN_COOKIE,
  OPERATOR_SESSION_COOKIE,
  readCookie,
  serializeCookie,
} from '../../../../../../lib/auth/cookies';
import { redirectResponse } from '../../../../../../lib/auth/http';
import { handleOperator } from '../../../../../../lib/operator-auth/handler';

export const dynamic = 'force-dynamic';

const MAX_PARAM_LENGTH = 2048;
const param = z.string().min(1).max(MAX_PARAM_LENGTH).optional();
const querySchema = z.object({ code: param, state: param, error: param });

/**
 * The operator realm's redirect target (#838). Validates state, exchanges the code with the PKCE verifier, verifies the
 * ID token, and only then creates the operator session. A sign-in without the operator second factor, or without the
 * platform role, creates nothing; the user lands on the sign-in page with the reason.
 */
export function GET(request: Request): Promise<Response> {
  return handleOperator(async ({ service, config }) => {
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    const outcome = await service.completeLogin({
      code: query.success ? query.data.code : undefined,
      state: query.success ? query.data.state : undefined,
      idpError: query.success ? query.data.error : undefined,
      loginCookie: readCookie(request.headers.get('cookie'), OPERATOR_LOGIN_COOKIE),
    });
    const consumed = clearCookie(OPERATOR_LOGIN_COOKIE);
    if (!outcome.ok) {
      return redirectResponse(`${config.consoleOrigin}/login?error=${outcome.reason}`, {
        cookies: [consumed],
      });
    }
    return redirectResponse(`${config.consoleOrigin}${outcome.returnTo}`, {
      cookies: [consumed, serializeCookie(OPERATOR_SESSION_COOKIE, outcome.sessionCookie)],
    });
  });
}
