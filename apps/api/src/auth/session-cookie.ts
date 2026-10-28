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
 *
 * The platform-operator BFF (#838) seals its session the same way under its own layout: a separate cookie purpose,
 * a separate Valkey keyspace (`op_session:`) and separate keys, so an operator cookie never opens as a tenant one.
 */
const SESSION_COOKIE_PURPOSE = 'session-cookie';
export const SESSION_RECORD_KEY_PREFIX = 'bw:web:sess:';
const SESSION_RECORD_PURPOSE_PREFIX = 'session:';

/** Where one BFF's sealed sessions live: its cookie purpose, Valkey key prefix and record purpose. */
export interface SessionLayout {
  readonly cookiePurpose: string;
  readonly recordKeyPrefix: string;
  readonly recordPurposePrefix: string;
}

/** The tenant console's BFF layout (IAM-002). */
const WEB_SESSION_LAYOUT: SessionLayout = Object.freeze({
  cookiePurpose: SESSION_COOKIE_PURPOSE,
  recordKeyPrefix: SESSION_RECORD_KEY_PREFIX,
  recordPurposePrefix: SESSION_RECORD_PURPOSE_PREFIX,
});

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

export interface SealedSessionOptions extends SessionCookieOptions {
  readonly layout: SessionLayout;
}

export interface OpenedSession {
  /** The opaque session id the cookie names. */
  readonly sid: string;
  /** The session record as opened, not yet parsed: each caller validates the shape it expects. */
  readonly record: unknown;
}

/**
 * Opens a BFF session cookie and the record it names (the shared core of every BFF session validator). Throws
 * `AppError`s only: a cookie that does not open is invalid, a missing record is expired, an unreachable store
 * is an outage.
 */
export async function openSealedSession(
  options: SealedSessionOptions,
  cookie: string,
): Promise<OpenedSession> {
  const { layout } = options;
  const envelope = cookieEnvelopeSchema.safeParse(
    open(options.keys, layout.cookiePurpose, cookie, options.now()),
  );
  if (!envelope.success) throw new AuthInvalidTokenError('session cookie does not open');
  const sid = envelope.data.sid;

  let stored: string | null;
  try {
    stored = await options.valkey.get(layout.recordKeyPrefix + sid);
  } catch (error) {
    throw new AuthSessionStoreUnavailableError({ cause: error });
  }
  // The session was ended, expired or never existed: the user signs in again.
  if (stored === null) throw new AuthExpiredError('session is no longer active');

  const record = open(options.keys, layout.recordPurposePrefix + sid, stored, options.now());
  if (record === null) throw new AuthInvalidTokenError('session record does not open');
  return { sid, record };
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
      const { record: opened } = await openSealedSession(
        { ...options, layout: WEB_SESSION_LAYOUT },
        cookie,
      );
      const record = sessionRecordSchema.safeParse(opened);
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
