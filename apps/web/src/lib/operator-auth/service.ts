// The platform-operator BFF flows (#838), free of HTTP so every branch is unit-testable: login start, callback,
// single-flight refresh, whoami and logout. It mirrors the tenant BFF (IAM-002) and differs where operators differ:
// the operator realm's identity carries no tenant, a sign-in without the operator second factor is refused
// (`acr` must be `operator_strong`), and the platform role is required. Route handlers only translate HTTP.

import { z } from 'zod';

import { OPERATOR_STRONG_ACR, PLATFORM_OPERATOR } from '@blackwing/contracts';

import {
  inOperatorSpan,
  type OperatorAuthMetrics,
  type OperatorLoginResult,
  type OperatorRefreshResult,
} from './metrics.js';
import {
  IdpRejectedError,
  IdpUnavailableError,
  InvalidIdTokenError,
  type OidcClient,
  type TokenSet,
} from '../auth/oidc.js';
import { codeChallenge, randomToken, safeEqual, sanitizeReturnTo } from '../auth/pkce.js';
import { open, seal } from '../auth/seal.js';
import { REFRESH_SKEW_MS } from '../auth/service.js';
import { SessionStoreUnavailableError } from '../auth/session-store.js';

import type { OperatorAuthConfig } from './config.js';
import type { OperatorSessionRecord, OperatorSessionStore } from './session-store.js';
import type { JWTPayload } from 'jose';

const LOGIN_PURPOSE = 'operator-login-cookie';
/** Seal purpose of the operator cookie; also the record purpose prefix in Valkey (`operator-session:<sid>`). */
const OPERATOR_SESSION_PURPOSE = 'operator-session-cookie';
export const OPERATOR_LOGIN_TTL_MS = 600_000;
const LOCK_TTL_MS = 15_000;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 3000;
/** Server-side lifetime when the IdP states none, and the absolute cap (the operator realm's 8h session). */
const DEFAULT_SESSION_TTL_MS = 900_000;
const MAX_SESSION_TTL_MS = 28_800_000;
const MS_PER_SECOND = 1000;
const PLATFORM_OPERATOR_ROLE: string = PLATFORM_OPERATOR;

const loginStateSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(1),
  returnTo: z.string().min(1),
});
const cookieSchema = z.object({ sid: z.string().min(1) });
const claimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1).optional(),
  preferred_username: z.string().min(1).optional(),
  name: z.string().optional(),
  acr: z.string().optional(),
  roles: z.array(z.string().min(1)).optional(),
  realm_access: z.object({ roles: z.array(z.string().min(1)) }).optional(),
});

export type OperatorIdentity = Pick<
  OperatorSessionRecord,
  'sub' | 'email' | 'name' | 'roles' | 'acr'
>;

/**
 * The operator identity from verified claims. `null` when the subject is missing. The `acr` may be empty: the callers
 * decide, and an empty or weaker `acr` is never treated as the second factor.
 */
export function operatorIdentityFromClaims(
  claims: JWTPayload | undefined,
): OperatorIdentity | null {
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    sub: c.sub,
    email: c.email ?? c.preferred_username ?? c.sub,
    name: c.name ?? c.preferred_username ?? '',
    roles: c.roles ?? c.realm_access?.roles ?? [],
    acr: c.acr ?? '',
  };
}

/** A sign-in or renewal may proceed only with the second factor (`acr`) and the platform role. */
function operatorMayAct(
  identity: OperatorIdentity,
): OperatorLoginResult | OperatorRefreshResult | null {
  if (identity.acr !== OPERATOR_STRONG_ACR) return 'mfa_required';
  if (!identity.roles.includes(PLATFORM_OPERATOR_ROLE)) return 'not_operator';
  return null;
}

/** Operator audit event (CONTEXT_PACK §8 #8): ids and codes only. The ledger writer is the platform ledger (IAM-012). */
export interface OperatorAuditEvent {
  readonly action: 'auth.operator_login' | 'auth.operator_logout' | 'auth.operator_session_revoked';
  readonly outcome: 'success' | 'failure';
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface OperatorAuthDeps {
  readonly config: Pick<OperatorAuthConfig, 'consoleOrigin' | 'sessionKeys'>;
  readonly oidc: OidcClient;
  readonly store: OperatorSessionStore;
  readonly metrics: OperatorAuthMetrics;
  readonly audit: (event: OperatorAuditEvent) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

type OperatorLoginOutcome =
  | { readonly ok: true; readonly sessionCookie: string; readonly returnTo: string }
  | { readonly ok: false; readonly reason: Exclude<OperatorLoginResult, 'success'> };

type OperatorAuthState =
  | { readonly status: 'ok'; readonly sid: string; readonly record: OperatorSessionRecord }
  /** No cookie, a cookie that does not open, or a session that no longer exists. */
  | { readonly status: 'none' }
  /** The IdP refused the renewal, or the operator lost the second factor or role: the user signs in again. */
  | { readonly status: 'reauth' }
  /** The IdP or Valkey could not be reached; the session was left untouched. */
  | { readonly status: 'unavailable' };

export interface OperatorAuthService {
  startLogin(returnTo: string | null): Promise<{ location: string; loginCookie: string }>;
  completeLogin(input: {
    code: string | undefined;
    state: string | undefined;
    idpError: string | undefined;
    loginCookie: string | undefined;
  }): Promise<OperatorLoginOutcome>;
  /** Resolves the session and, unless `renew` is false, renews the tokens when they are about to expire. */
  authenticate(sessionCookie: string | undefined, renew?: boolean): Promise<OperatorAuthState>;
  /** Ends the session here and returns where the browser goes next (Keycloak's end-session endpoint). */
  logout(sessionCookie: string | undefined): Promise<{ redirectTo: string }>;
}

export function createOperatorAuthService(deps: OperatorAuthDeps): OperatorAuthService {
  const { config, oidc, store, metrics, audit, now } = deps;

  const fresh = (record: OperatorSessionRecord): boolean =>
    record.accessExpiresAt - now() > REFRESH_SKEW_MS;

  function sessionTtlMs(tokens: TokenSet): number {
    const seconds = tokens.refreshExpiresInSeconds;
    const ttl =
      seconds === undefined || seconds === 0 ? DEFAULT_SESSION_TTL_MS : seconds * MS_PER_SECOND;
    return Math.min(ttl, MAX_SESSION_TTL_MS);
  }

  function sealSid(sid: string, ttlMs: number): string {
    return seal(config.sessionKeys[0], OPERATOR_SESSION_PURPOSE, { sid }, ttlMs, now());
  }

  function sidFromCookie(sessionCookie: string | undefined): string | undefined {
    if (sessionCookie === undefined) return undefined;
    const parsed = cookieSchema.safeParse(
      open(config.sessionKeys, OPERATOR_SESSION_PURPOSE, sessionCookie, now()),
    );
    return parsed.success ? parsed.data.sid : undefined;
  }

  async function destroy(
    sid: string,
    record: OperatorSessionRecord,
    reason: string,
  ): Promise<void> {
    await store.delete(sid);
    audit({
      action: 'auth.operator_session_revoked',
      outcome: 'success',
      operatorId: record.sub,
      reason,
    });
  }

  function failLogin(reason: Exclude<OperatorLoginResult, 'success'>): OperatorLoginOutcome {
    metrics.login(reason);
    audit({ action: 'auth.operator_login', outcome: 'failure', reason });
    return { ok: false, reason };
  }

  async function renewSession(sid: string): Promise<OperatorAuthState> {
    const owner = randomToken();
    if (!(await store.tryLock(sid, owner, LOCK_TTL_MS))) return waitForPeer(sid);
    try {
      const current = (await store.get(sid)) ?? undefined;
      if (current === undefined) return { status: 'none' };
      if (fresh(current)) return { status: 'ok', sid, record: current };
      if (current.refreshToken === undefined) {
        metrics.refresh('no_refresh_token');
        await destroy(sid, current, 'no_refresh_token');
        return { status: 'reauth' };
      }
      return await refreshTokens(sid, current, current.refreshToken);
    } finally {
      await store.unlock(sid, owner).catch(() => undefined);
    }
  }

  async function refreshTokens(
    sid: string,
    current: OperatorSessionRecord,
    refreshToken: string,
  ): Promise<OperatorAuthState> {
    let tokens: TokenSet;
    try {
      tokens = await oidc.refresh(refreshToken);
    } catch (error) {
      if (error instanceof IdpUnavailableError) {
        metrics.refresh('idp_unavailable');
        return { status: 'unavailable' };
      }
      const result: OperatorRefreshResult =
        error instanceof IdpRejectedError ? 'rejected' : 'invalid_token';
      metrics.refresh(result);
      await destroy(sid, current, result);
      return { status: 'reauth' };
    }
    // The renewed token must still name the same operator, with the second factor and the platform role. Any
    // change ends the session: an operator who lost MFA or the role is not renewed.
    const identity =
      tokens.claims === undefined ? identityOf(current) : operatorIdentityFromClaims(tokens.claims);
    if (identity === null || (tokens.claims !== undefined && tokens.claims.sub !== current.sub)) {
      metrics.refresh('invalid_token');
      await destroy(sid, current, 'identity_changed');
      return { status: 'reauth' };
    }
    const refusal = operatorMayAct(identity);
    if (refusal !== null) {
      metrics.refresh(refusal === 'mfa_required' ? 'mfa_lost' : 'not_operator');
      if (refusal === 'mfa_required') metrics.mfaRequired();
      await destroy(sid, current, refusal);
      return { status: 'reauth' };
    }
    // A refresh answer without a new refresh/ID token keeps the ones we hold.
    const refreshed = tokens.refreshToken ?? current.refreshToken;
    const idToken = tokens.idToken ?? current.idToken;
    const next: OperatorSessionRecord = {
      ...identity,
      accessToken: tokens.accessToken,
      ...(refreshed === undefined ? {} : { refreshToken: refreshed }),
      ...(idToken === undefined ? {} : { idToken }),
      accessExpiresAt: now() + tokens.expiresInSeconds * MS_PER_SECOND,
      csrf: current.csrf,
    };
    if (!(await store.replace(sid, next, sessionTtlMs(tokens)))) return { status: 'none' };
    metrics.refresh('success');
    return { status: 'ok', sid, record: next };
  }

  /** Another request owns the refresh lock: wait for its result instead of refreshing again. */
  async function waitForPeer(sid: string): Promise<OperatorAuthState> {
    for (let waited = 0; waited < LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
      await deps.sleep(LOCK_POLL_MS);
      const record = await store.get(sid);
      if (record === null) return { status: 'none' };
      if (fresh(record)) return { status: 'ok', sid, record };
    }
    metrics.refresh('busy');
    return { status: 'unavailable' };
  }

  return {
    async startLogin(returnTo) {
      const verifier = randomToken();
      const login = {
        state: randomToken(),
        nonce: randomToken(),
        verifier,
        returnTo: sanitizeReturnTo(returnTo),
      };
      const url = await oidc.authorizationUrl({
        state: login.state,
        nonce: login.nonce,
        challenge: codeChallenge(verifier),
      });
      return {
        location: url.href,
        loginCookie: seal(
          config.sessionKeys[0],
          LOGIN_PURPOSE,
          login,
          OPERATOR_LOGIN_TTL_MS,
          now(),
        ),
      };
    },

    completeLogin: (input) =>
      inOperatorSpan('auth.operator.callback', async () => {
        const parsed = loginStateSchema.safeParse(
          input.loginCookie === undefined
            ? undefined
            : open(config.sessionKeys, LOGIN_PURPOSE, input.loginCookie, now()),
        );
        if (!parsed.success) return failLogin('invalid_state');
        const login = parsed.data;
        // The state binds this callback to the browser that started the operator login (CSRF / fixation).
        if (input.state === undefined || !safeEqual(input.state, login.state)) {
          return failLogin('invalid_state');
        }
        if (input.idpError !== undefined) return failLogin('denied');
        if (input.code === undefined) return failLogin('invalid_state');

        let tokens: TokenSet;
        try {
          tokens = await oidc.exchangeCode({
            code: input.code,
            verifier: login.verifier,
            nonce: login.nonce,
          });
        } catch (error) {
          if (error instanceof IdpUnavailableError) return failLogin('idp_unavailable');
          return failLogin(
            error instanceof InvalidIdTokenError ? 'invalid_token' : 'exchange_failed',
          );
        }
        const identity = operatorIdentityFromClaims(tokens.claims);
        if (identity === null) return failLogin('invalid_token');
        const refusal = operatorMayAct(identity);
        if (refusal === 'mfa_required') {
          metrics.mfaRequired();
          return failLogin('mfa_required');
        }
        if (refusal !== null) return failLogin('not_operator');

        const sid = randomToken();
        const ttl = sessionTtlMs(tokens);
        try {
          // Last step: nothing exists until the whole exchange has been verified (no partial session).
          await store.create(
            sid,
            {
              ...identity,
              accessToken: tokens.accessToken,
              ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
              ...(tokens.idToken === undefined ? {} : { idToken: tokens.idToken }),
              accessExpiresAt: now() + tokens.expiresInSeconds * MS_PER_SECOND,
              csrf: randomToken(),
            },
            ttl,
          );
        } catch (error) {
          if (error instanceof SessionStoreUnavailableError) return failLogin('store_unavailable');
          throw error;
        }
        metrics.login('success');
        audit({ action: 'auth.operator_login', outcome: 'success', operatorId: identity.sub });
        return { ok: true, sessionCookie: sealSid(sid, ttl), returnTo: login.returnTo };
      }),

    authenticate: (sessionCookie, renew = true) =>
      inOperatorSpan('auth.operator.session', async () => {
        const sid = sidFromCookie(sessionCookie);
        if (sid === undefined) return { status: 'none' };
        let record: OperatorSessionRecord | null;
        try {
          record = await store.get(sid);
        } catch (error) {
          if (error instanceof SessionStoreUnavailableError) return { status: 'unavailable' };
          throw error;
        }
        if (record === null) return { status: 'none' };
        if (!renew || fresh(record)) return { status: 'ok', sid, record };
        try {
          return await renewSession(sid);
        } catch (error) {
          if (error instanceof SessionStoreUnavailableError) return { status: 'unavailable' };
          throw error;
        }
      }),

    logout: (sessionCookie) =>
      inOperatorSpan('auth.operator.logout', async () => {
        const sid = sidFromCookie(sessionCookie);
        const record = sid === undefined ? null : await store.get(sid);
        if (sid !== undefined) await store.delete(sid);
        metrics.logout();
        audit({
          action: 'auth.operator_logout',
          outcome: 'success',
          ...(record === null ? {} : { operatorId: record.sub }),
        });
        const endSession = await oidc
          .endSessionUrl({ idToken: record?.idToken })
          .catch(() => undefined);
        return { redirectTo: endSession?.href ?? '/' };
      }),
  };
}

function identityOf(record: OperatorSessionRecord): OperatorIdentity {
  const { sub, email, name, roles, acr } = record;
  return { sub, email, name, roles, acr };
}
