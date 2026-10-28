import { z } from 'zod';

import { principalSchema, type Principal } from '@blackwing/contracts';
import { open } from '@blackwing/crypto';

import {
  AuthExpiredError,
  AuthInvalidTokenError,
  AuthSessionStoreUnavailableError,
} from './errors.js';

/*
 * The BFF session (IAM-002, apps/web): the browser holds only `__Host-bw_session`, a sealed opaque session id
 * (purpose `session-cookie`). The record it names lives in Valkey under `bw:web:sess:<sid>`, sealed with the
 * same key (purpose `session:<sid>`). This validator opens both with the same keys the BFF uses.
 */
const SESSION_COOKIE_PURPOSE = 'session-cookie';
export const SESSION_RECORD_KEY_PREFIX = 'bw:web:sess:';
const SESSION_RECORD_PURPOSE_PREFIX = 'session:';

const cookieEnvelopeSchema = z.object({ sid: z.string().min(1) });
const sessionRecordSchema = z.object({
  sub: z.string().min(1),
  tenantId: z.string().min(1),
  roles: z.array(z.string().min(1)),
});

/** The read the validator needs from Valkey (an ioredis client satisfies it). */
export interface SessionValkey {
  get(key: string): Promise<string | null>;
}

export interface SessionCookieOptions {
  /** The BFF session keys: the current key first, then any previous key still accepted for opening. */
  readonly keys: readonly [Buffer, ...Buffer[]];
  readonly valkey: SessionValkey;
  readonly now: () => number;
}

export interface SessionCookieValidator {
  /** Resolves a BFF session cookie to its principal. Throws `AppError`s only; a missing record is expired. */
  validate(cookie: string): Promise<Principal>;
}

export function createSessionCookieValidator(
  options: SessionCookieOptions,
): SessionCookieValidator {
  return {
    async validate(cookie) {
      const envelope = cookieEnvelopeSchema.safeParse(
        open(options.keys, SESSION_COOKIE_PURPOSE, cookie, options.now()),
      );
      if (!envelope.success) throw new AuthInvalidTokenError('session cookie does not open');
      const sid = envelope.data.sid;

      let stored: string | null;
      try {
        stored = await options.valkey.get(SESSION_RECORD_KEY_PREFIX + sid);
      } catch (error) {
        throw new AuthSessionStoreUnavailableError({ cause: error });
      }
      // The session was ended, expired or never existed: the user signs in again.
      if (stored === null) throw new AuthExpiredError('session is no longer active');

      const record = sessionRecordSchema.safeParse(
        open(options.keys, SESSION_RECORD_PURPOSE_PREFIX + sid, stored, options.now()),
      );
      if (!record.success) throw new AuthInvalidTokenError('session record does not open');
      const principal = principalSchema.safeParse({
        subjectId: record.data.sub,
        kind: 'user',
        tenantId: record.data.tenantId,
        roles: record.data.roles,
        scopes: [],
        authMethod: 'bff_session',
      });
      if (!principal.success)
        throw new AuthInvalidTokenError('session tenant or subject is invalid');
      return principal.data;
    },
  };
}
