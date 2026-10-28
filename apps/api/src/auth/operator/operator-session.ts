import { z } from 'zod';

import {
  OPERATOR_STRONG_ACR,
  operatorPrincipalSchema,
  type OperatorPrincipal,
} from '@blackwing/contracts';

import { AuthInvalidTokenError } from '../errors.js';
import {
  openSealedSession,
  type SessionLayout,
  type SessionCookieOptions,
} from '../session-cookie.js';
import { OperatorMfaRequiredError } from './errors.js';

/*
 * The platform-operator BFF session (#838, apps/web `/operator/api/auth/*`). The browser holds only
 * `__Host-bw_op_session`, a sealed opaque id sealed with the OPERATOR key, purpose `operator-session-cookie`. The
 * record lives in Valkey under its own keyspace `op_session:<sid>`. Nothing about a tenant session can open here.
 */

/** The operator cookie name. Distinct from the tenant `__Host-bw_session`, so the two can never be swapped. */
export const OPERATOR_SESSION_COOKIE = '__Host-bw_op_session';

export const OPERATOR_SESSION_LAYOUT: SessionLayout = Object.freeze({
  cookiePurpose: 'operator-session-cookie',
  recordKeyPrefix: 'op_session:',
  recordPurposePrefix: 'operator-session:',
});

const operatorSessionRecordSchema = z.object({
  sub: z.string().min(1),
  roles: z.array(z.string().min(1)),
  acr: z.string().min(1),
});

export type OperatorSessionOptions = SessionCookieOptions;

export interface OperatorSessionValidator {
  /** Resolves an operator session cookie to its principal. Throws `AppError`s only. */
  validate(cookie: string): Promise<OperatorPrincipal>;
}

export function createOperatorSessionValidator(
  options: OperatorSessionOptions,
): OperatorSessionValidator {
  return {
    async validate(cookie) {
      const { record: opened } = await openSealedSession(
        { ...options, layout: OPERATOR_SESSION_LAYOUT },
        cookie,
      );
      const record = operatorSessionRecordSchema.safeParse(opened);
      if (!record.success) throw new AuthInvalidTokenError('operator session record does not open');
      // The second factor is re-checked on every request, not only at login: the stored acr is the proof.
      if (record.data.acr !== OPERATOR_STRONG_ACR) throw new OperatorMfaRequiredError();
      const principal = operatorPrincipalSchema.safeParse({
        operatorId: record.data.sub,
        kind: 'operator',
        roles: record.data.roles,
        acr: OPERATOR_STRONG_ACR,
        authMethod: 'operator_session',
      });
      if (!principal.success) throw new AuthInvalidTokenError('operator principal is invalid');
      return principal.data;
    },
  };
}
