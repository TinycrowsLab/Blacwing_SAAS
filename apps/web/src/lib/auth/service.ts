// The BFF auth flows (IAM-002, #334), free of HTTP so every branch is unit-testable: login start,
// callback, silent single-flight refresh, whoami and logout. Route handlers only translate between
// requests/responses and these functions.
//
// Session model: login mints a fresh opaque session id (so a pre-login id can never be fixated). The
// id is the only thing the browser holds (sealed, httpOnly, `__Host-`); tokens stay in Valkey. A
// refresh rotates the token set held under that id and keeps the id and CSRF secret, so concurrent
// tabs and server-rendered pages (which cannot set cookies) keep working. A refresh the IdP refuses
// (revoked, expired, or a reused rotated token) destroys the session and forces a new login. A
// back-channel logout (#336) from Keycloak ends the sessions of the Keycloak session it names.

import { z } from 'zod';

import {
  inSpan,
  type AuthMetrics,
  type BackchannelResult,
  type LoginResult,
  type RefreshResult,
} from './metrics.js';
import {
  CLOCK_LEEWAY_SECONDS,
  IdpRejectedError,
  IdpUnavailableError,
  InvalidIdTokenError,
  InvalidLogoutTokenError,
  LOGOUT_TOKEN_MAX_AGE_SECONDS,
  type LogoutTokenClaims,
  type OidcClient,
  type TokenSet,
} from './oidc.js';
import { codeChallenge, randomToken, safeEqual, sanitizeReturnTo } from './pkce.js';
import { open, seal } from './seal.js';
import {
  MAX_SESSION_TTL_MS,
  SessionStoreUnavailableError,
  type SessionIndex,
  type SessionRecord,
  type SessionStore,
} from './session-store.js';

import type { AuthConfig } from './config.js';
import type { JWTPayload } from 'jose';

const LOGIN_PURPOSE = 'login-cookie';
const SESSION_PURPOSE = 'session-cookie';
export const LOGIN_TTL_MS = 600_000;
/** The access token is renewed once it has less than this left. */
export const REFRESH_SKEW_MS = 60_000;
const LOCK_TTL_MS = 15_000;
const LOCK_POLL_MS = 100;
const LOCK_WAIT_MS = 3000;
/** Server-side session lifetime when the IdP states none (the absolute cap is `MAX_SESSION_TTL_MS`). */
const DEFAULT_SESSION_TTL_MS = 1_800_000;
/** A back-channel logout token's `jti` is refused for as long as the token itself is still accepted. */
const MS_PER_SECOND = 1000;
const LOGOUT_TOKEN_REPLAY_TTL_MS =
  (LOGOUT_TOKEN_MAX_AGE_SECONDS + CLOCK_LEEWAY_SECONDS) * MS_PER_SECOND;

type AuthAuditAction = 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.session_revoked';

/** Login/logout/revocation audit event (CONTEXT_PACK §8 #8). The ledger writer arrives with IAM-012 (#340). */
export interface AuthAuditEvent {
  readonly action: AuthAuditAction;
  readonly outcome: 'success' | 'failure';
  readonly userId?: string;
  readonly tenantId?: string;
  readonly reason?: string;
}

export interface AuthDeps {
  readonly config: Pick<AuthConfig, 'consoleOrigin' | 'sessionKeys'>;
  readonly oidc: OidcClient;
  readonly store: SessionStore;
  readonly metrics: AuthMetrics;
  readonly audit: (event: AuthAuditEvent) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

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
  name: z.string().optional(),
  preferred_username: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
  tenantSlug: z.string().min(1).optional(),
  /** The dev realm maps the tenant slug to this claim. */
  tenant: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).optional(),
  realm_access: z.object({ roles: z.array(z.string().min(1)) }).optional(),
});

type Identity = Pick<SessionRecord, 'sub' | 'email' | 'name' | 'tenantId' | 'tenantSlug' | 'roles'>;

/** The Keycloak session an ID token belongs to (`sid`), when the IdP states one. */
function idpSidOf(claims: JWTPayload | undefined): string | undefined {
  return typeof claims?.sid === 'string' && claims.sid !== '' ? claims.sid : undefined;
}

/** Identity from verified ID-token claims; `null` when there is no tenant (the console is tenant-scoped). */
export function identityFromClaims(claims: JWTPayload | undefined): Identity | null {
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) return null;
  const c = parsed.data;
  const tenantId = c.tenantId ?? c.tenant;
  if (tenantId === undefined) return null;
  return {
    sub: c.sub,
    email: c.email ?? c.preferred_username ?? c.sub,
    name: c.name ?? c.preferred_username ?? '',
    tenantId,
    tenantSlug: c.tenantSlug ?? c.tenant ?? tenantId,
    roles: c.roles ?? c.realm_access?.roles ?? [],
  };
}

type LoginFailure = Exclude<LoginResult, 'success'>;

type LoginOutcome =
  | { readonly ok: true; readonly sessionCookie: string; readonly returnTo: string }
  | { readonly ok: false; readonly reason: LoginFailure };

type AuthState =
  | { readonly status: 'ok'; readonly sid: string; readonly record: SessionRecord }
  /** No cookie, a cookie that does not open, or a session that no longer exists. */
  | { readonly status: 'none' }
  /** The IdP refused the refresh: the session was destroyed and the user must sign in again. */
  | { readonly status: 'reauth' }
  /** The IdP or Valkey could not be reached; the session was left untouched. */
  | { readonly status: 'unavailable' };

export interface AuthService {
  startLogin(returnTo: string | null): Promise<{ location: string; loginCookie: string }>;
  completeLogin(input: {
    code: string | undefined;
    state: string | undefined;
    idpError: string | undefined;
    loginCookie: string | undefined;
  }): Promise<LoginOutcome>;
  /**
   * Resolves the session and, unless `renew` is false, silently renews the tokens when they are about
   * to expire. `renew: false` only looks the session up (logout needs its CSRF secret, not fresh tokens).
   */
  authenticate(sessionCookie: string | undefined, renew?: boolean): Promise<AuthState>;
  /** Ends the session here and returns where the browser goes next (Keycloak's end-session endpoint). */
  logout(sessionCookie: string | undefined): Promise<{ redirectTo: string }>;
  /**
   * Handles a Keycloak back-channel logout (#336): verifies the logout token and ends the BFF sessions
   * it names (its `sid`, or every session of its `sub`). Resolves the outcome; an IdP or Valkey outage throws.
   */
  backchannelLogout(logoutToken: string | undefined): Promise<BackchannelResult>;
}

export function createAuthService(deps: AuthDeps): AuthService {
  const { config, oidc, store, metrics, audit, now } = deps;

  const fresh = (record: SessionRecord): boolean =>
    record.accessExpiresAt - now() > REFRESH_SKEW_MS;

  function sessionTtlMs(tokens: TokenSet): number {
    const seconds = tokens.refreshExpiresInSeconds;
    const ttl =
      seconds === undefined || seconds === 0 ? DEFAULT_SESSION_TTL_MS : seconds * MS_PER_SECOND;
    return Math.min(ttl, MAX_SESSION_TTL_MS);
  }

  function sealSid(sid: string, ttlMs: number): string {
    return seal(config.sessionKeys[0], SESSION_PURPOSE, { sid }, ttlMs, now());
  }

  function sidFromCookie(sessionCookie: string | undefined): string | undefined {
    if (sessionCookie === undefined) return undefined;
    const parsed = cookieSchema.safeParse(
      open(config.sessionKeys, SESSION_PURPOSE, sessionCookie, now()),
    );
    return parsed.success ? parsed.data.sid : undefined;
  }

  async function destroy(sid: string, record: SessionRecord, reason: string): Promise<void> {
    await store.delete(sid);
    audit({
      action: 'auth.session_revoked',
      outcome: 'success',
      userId: record.sub,
      tenantId: record.tenantId,
      reason,
    });
  }

  function failLogin(reason: LoginFailure): LoginOutcome {
    metrics.login(reason);
    audit({ action: 'auth.login_failed', outcome: 'failure', reason });
    return { ok: false, reason };
  }

  async function renewSession(sid: string): Promise<AuthState> {
    const owner = randomToken();
    if (!(await store.tryLock(sid, owner, LOCK_TTL_MS))) return waitForPeer(sid);
    try {
      const current = (await store.get(sid)) ?? undefined;
      if (current === undefined) return { status: 'none' };
      if (fresh(current)) return { status: 'ok', sid, record: current };
      const refreshToken = current.refreshToken;
      if (refreshToken === undefined) {
        metrics.refresh('no_refresh_token');
        await destroy(sid, current, 'no_refresh_token');
        return { status: 'reauth' };
      }
      return await refreshTokens(sid, current, refreshToken);
    } finally {
      await store.unlock(sid, owner).catch(() => undefined);
    }
  }

  async function refreshTokens(
    sid: string,
    current: SessionRecord,
    refreshToken: string,
  ): Promise<AuthState> {
    let tokens: TokenSet;
    try {
      tokens = await oidc.refresh(refreshToken);
    } catch (error) {
      if (error instanceof IdpUnavailableError) {
        metrics.refresh('idp_unavailable');
        return { status: 'unavailable' };
      }
      const result: RefreshResult =
        error instanceof IdpRejectedError ? 'rejected' : 'invalid_token';
      metrics.refresh(result);
      await destroy(sid, current, result);
      return { status: 'reauth' };
    }
    // Roles and tenant follow the IdP: a refreshed ID token replaces the identity, and one without a
    // tenant ends the session.
    const identity =
      tokens.claims === undefined ? identityOf(current) : identityFromClaims(tokens.claims);
    if (identity === null || (tokens.claims !== undefined && tokens.claims.sub !== current.sub)) {
      metrics.refresh('invalid_token');
      await destroy(sid, current, 'identity_changed');
      return { status: 'reauth' };
    }
    // A refresh answer without a new refresh/ID token keeps the ones we hold.
    const refreshed = tokens.refreshToken ?? current.refreshToken;
    const idToken = tokens.idToken ?? current.idToken;
    const next: SessionRecord = {
      ...identity,
      accessToken: tokens.accessToken,
      ...(refreshed === undefined ? {} : { refreshToken: refreshed }),
      ...(idToken === undefined ? {} : { idToken }),
      // The Keycloak session does not change on refresh, so the index entry built at login stays valid.
      ...(current.idpSid === undefined ? {} : { idpSid: current.idpSid }),
      accessExpiresAt: now() + tokens.expiresInSeconds * MS_PER_SECOND,
      csrf: current.csrf,
    };
    if (!(await store.replace(sid, next, sessionTtlMs(tokens)))) return { status: 'none' };
    metrics.refresh('success');
    return { status: 'ok', sid, record: next };
  }

  /** Ends the sessions a verified back-channel logout token names; `replayed` when its `jti` was seen. */
  async function backchannel(logoutToken: string | undefined): Promise<BackchannelResult> {
    if (logoutToken === undefined) return 'invalid_token';
    let claims: LogoutTokenClaims;
    try {
      claims = await oidc.verifyLogoutToken(logoutToken);
    } catch (error) {
      if (error instanceof InvalidLogoutTokenError) return 'invalid_token';
      throw error;
    }
    // A logout token is single-use: a captured one must not end a session that was started since.
    if (!(await store.claimOnce(claims.jti, LOGOUT_TOKEN_REPLAY_TTL_MS))) return 'replayed';
    const index: SessionIndex | undefined =
      claims.sid !== undefined
        ? { kind: 'idp', sid: claims.sid }
        : claims.sub !== undefined
          ? { kind: 'user', sub: claims.sub }
          : undefined;
    if (index === undefined) return 'invalid_token';
    // When the token names both, only the sessions of that subject end, whichever Keycloak session matched.
    const subject = claims.sub;
    const revoked = await store.revokeWhere(index, (record) =>
      subject === undefined ? true : record.sub === subject,
    );
    for (const record of revoked) {
      audit({
        action: 'auth.session_revoked',
        outcome: 'success',
        userId: record.sub,
        tenantId: record.tenantId,
        reason: 'backchannel_logout',
      });
    }
    metrics.sessionRevocation('backchannel');
    return 'success';
  }

  /** Another request owns the refresh lock: wait for its result instead of refreshing again. */
  async function waitForPeer(sid: string): Promise<AuthState> {
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
        loginCookie: seal(config.sessionKeys[0], LOGIN_PURPOSE, login, LOGIN_TTL_MS, now()),
      };
    },

    completeLogin: (input) =>
      inSpan('auth.callback', async () => {
        const parsed = loginStateSchema.safeParse(
          input.loginCookie === undefined
            ? undefined
            : open(config.sessionKeys, LOGIN_PURPOSE, input.loginCookie, now()),
        );
        if (!parsed.success) return failLogin('invalid_state');
        const login = parsed.data;
        // The state binds this callback to the browser that started the login (CSRF / login fixation).
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
        const identity = identityFromClaims(tokens.claims);
        if (identity === null) return failLogin('no_tenant');
        const idpSid = idpSidOf(tokens.claims);

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
              ...(idpSid === undefined ? {} : { idpSid }),
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
        audit({
          action: 'auth.login',
          outcome: 'success',
          userId: identity.sub,
          tenantId: identity.tenantId,
        });
        return { ok: true, sessionCookie: sealSid(sid, ttl), returnTo: login.returnTo };
      }),

    authenticate: (sessionCookie, renew = true) =>
      inSpan('auth.session', async () => {
        const sid = sidFromCookie(sessionCookie);
        if (sid === undefined) return { status: 'none' };
        let record: SessionRecord | null;
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
      inSpan('auth.logout', async () => {
        const sid = sidFromCookie(sessionCookie);
        const record = sid === undefined ? null : await store.get(sid);
        if (sid !== undefined) await store.delete(sid);
        metrics.logout();
        audit({
          action: 'auth.logout',
          outcome: 'success',
          ...(record === null ? {} : { userId: record.sub, tenantId: record.tenantId }),
        });
        const endSession = await oidc
          .endSessionUrl({ idToken: record?.idToken })
          .catch(() => undefined);
        return { redirectTo: endSession?.href ?? '/' };
      }),

    async backchannelLogout(logoutToken) {
      try {
        const result = await inSpan('auth.backchannel_logout', () => backchannel(logoutToken));
        metrics.backchannelLogout(result);
        return result;
      } catch (error) {
        if (error instanceof IdpUnavailableError || error instanceof SessionStoreUnavailableError) {
          metrics.backchannelLogout('unavailable');
        }
        throw error;
      }
    },
  };
}

function identityOf(record: SessionRecord): Identity {
  const { sub, email, name, tenantId, tenantSlug, roles } = record;
  return { sub, email, name, tenantId, tenantSlug, roles };
}
