// OIDC relying-party calls for the BFF (IAM-002, #334): discovery, the authorize URL, the server-side
// code exchange, refresh and RP-initiated logout against Keycloak. ID tokens are verified (signature
// against the issuer's JWKS, `iss`, `aud`, `exp`/`iat` with a small clock leeway, and the login
// `nonce`) before anything is trusted. Back-channel logout tokens (OIDC Back-Channel Logout 1.0) are
// verified the same way, plus their own claims. Tokens and codes never appear in an error message or a log.

import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

import type { AuthConfig } from './config.js';

const SCOPE = 'openid profile email';
const REQUEST_TIMEOUT_MS = 5000;
const DISCOVERY_TTL_MS = 600_000;
/** Tolerated clock skew between this host and Keycloak when checking `exp`/`iat`. */
export const CLOCK_LEEWAY_SECONDS = 30;
/** A back-channel logout token older than this is refused; its `jti` is remembered at least this long. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 120;
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const SIGNING_ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const HTTP_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;

/** Keycloak could not be reached or answered 5xx: retryable, no session state may change. */
export class IdpUnavailableError extends Error {
  override readonly name = 'IdpUnavailableError';
  constructor() {
    super('The identity provider is unavailable');
  }
}

/** Keycloak refused the request (4xx, e.g. `invalid_grant` for an expired, revoked or reused token). */
export class IdpRejectedError extends Error {
  override readonly name = 'IdpRejectedError';
  constructor(readonly oauthError: string) {
    super(`The identity provider rejected the request (${oauthError})`);
  }
}

/** The ID token failed verification (signature, issuer, audience, expiry or nonce). */
export class InvalidIdTokenError extends Error {
  override readonly name = 'InvalidIdTokenError';
  constructor() {
    super('The ID token failed verification');
  }
}

/** The back-channel logout token failed verification (signature, claims, event or age). */
export class InvalidLogoutTokenError extends Error {
  override readonly name = 'InvalidLogoutTokenError';
  constructor() {
    super('The logout token failed verification');
  }
}

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  end_session_endpoint: z.url().optional(),
});
type Discovery = z.infer<typeof discoverySchema>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((type) => type.toLowerCase() === 'bearer'),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_expires_in: z.number().nonnegative().optional(),
  id_token: z.string().min(1).optional(),
});

/** What a token endpoint answer yields once verified. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
  readonly expiresInSeconds: number;
  /** Lifetime of the refresh token; `undefined` when the IdP did not say. */
  readonly refreshExpiresInSeconds: number | undefined;
  /** Verified ID token claims (`undefined` when the answer carried no ID token). */
  readonly claims: JWTPayload | undefined;
}

/** The verified claims of a back-channel logout token that the BFF acts on. */
export interface LogoutTokenClaims {
  /** The user whose sessions end, when the token names one. */
  readonly sub: string | undefined;
  /** The Keycloak session that ends, when the token names one. */
  readonly sid: string | undefined;
  /** Unique id of this token, remembered so a replay is refused. */
  readonly jti: string;
}

export interface OidcClient {
  /** `idpHint` (Keycloak `kc_idp_hint`) starts a brokered identity provider directly; the caller allow-lists it. */
  authorizationUrl(params: {
    state: string;
    nonce: string;
    challenge: string;
    idpHint?: string | undefined;
  }): Promise<URL>;
  exchangeCode(params: { code: string; verifier: string; nonce: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** RP-initiated logout URL, or `undefined` when the IdP advertises no `end_session_endpoint`. */
  endSessionUrl(params: { idToken: string | undefined }): Promise<URL | undefined>;
  /**
   * Verifies a back-channel logout token: signature, issuer, audience, the logout `events` member, no
   * `nonce`, a `jti`, a `sub` or `sid`, and an `iat` within {@link LOGOUT_TOKEN_MAX_AGE_SECONDS}.
   */
  verifyLogoutToken(token: string): Promise<LogoutTokenClaims>;
}

export interface OidcDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly getKeySet?: (jwksUri: URL) => JWTVerifyGetKey;
}

function sameOrigin(url: string, issuer: string): boolean {
  return new URL(url).origin === new URL(issuer).origin;
}

export function createOidcClient(
  config: Pick<
    AuthConfig,
    'issuer' | 'clientId' | 'clientSecret' | 'redirectUri' | 'consoleOrigin'
  >,
  deps: OidcDeps,
): OidcClient {
  const getKeySet = deps.getKeySet ?? ((uri: URL): JWTVerifyGetKey => createRemoteJWKSet(uri));
  let cached:
    { readonly doc: Discovery; readonly keys: JWTVerifyGetKey; readonly at: number } | undefined;

  async function send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        ...init,
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new IdpUnavailableError();
    }
    if (response.status >= HTTP_SERVER_ERROR) throw new IdpUnavailableError();
    return response;
  }

  async function discover(): Promise<{ doc: Discovery; keys: JWTVerifyGetKey }> {
    if (cached !== undefined && deps.now() - cached.at < DISCOVERY_TTL_MS) return cached;
    const response = await send(`${config.issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    const parsed = discoverySchema.safeParse(response.ok ? await response.json() : null);
    // Every endpoint must live on the issuer's origin: a poisoned document must not redirect the
    // browser or the code exchange anywhere else.
    if (
      !parsed.success ||
      parsed.data.issuer !== config.issuer ||
      ![
        parsed.data.authorization_endpoint,
        parsed.data.token_endpoint,
        parsed.data.jwks_uri,
        parsed.data.end_session_endpoint ?? config.issuer,
      ].every((url) => sameOrigin(url, config.issuer))
    ) {
      throw new IdpUnavailableError();
    }
    cached = { doc: parsed.data, keys: getKeySet(new URL(parsed.data.jwks_uri)), at: deps.now() };
    return cached;
  }

  async function tokenRequest(
    form: Record<string, string>,
    expectedNonce: string | undefined,
  ): Promise<TokenSet> {
    const { doc, keys } = await discover();
    const body = new URLSearchParams({ ...form, client_id: config.clientId });
    if (config.clientSecret !== undefined) body.set('client_secret', config.clientSecret);
    const response = await send(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(json);
      throw new IdpRejectedError(error.success ? error.data.error : 'invalid_response');
    }
    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) throw new IdpRejectedError('invalid_response');
    const token = parsed.data;
    let claims: JWTPayload | undefined;
    if (token.id_token !== undefined) {
      claims = await verifyIdToken(token.id_token, keys, expectedNonce);
    } else if (expectedNonce !== undefined) {
      throw new InvalidIdTokenError();
    }
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      idToken: token.id_token,
      expiresInSeconds: token.expires_in,
      refreshExpiresInSeconds: token.refresh_expires_in,
      claims,
    };
  }

  /**
   * Verifies a token against the issuer's keys. A JWKS that cannot be fetched is an outage; everything
   * else is a token that does not verify, reported as the error `refuse` builds.
   */
  async function verifyJwt(
    token: string,
    keys: JWTVerifyGetKey,
    requiredClaims: string[],
    refuse: () => Error,
  ): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: SIGNING_ALGORITHMS,
        clockTolerance: CLOCK_LEEWAY_SECONDS,
        currentDate: new Date(deps.now()),
        requiredClaims,
      });
      return payload;
    } catch (error) {
      const outage =
        !(error instanceof joseErrors.JOSEError) ||
        error instanceof joseErrors.JWKSTimeout ||
        error.code === 'ERR_JOSE_GENERIC';
      throw outage ? new IdpUnavailableError() : refuse();
    }
  }

  async function verifyIdToken(
    idToken: string,
    keys: JWTVerifyGetKey,
    expectedNonce: string | undefined,
  ): Promise<JWTPayload> {
    const payload = await verifyJwt(
      idToken,
      keys,
      ['exp', 'iat', 'sub'],
      () => new InvalidIdTokenError(),
    );
    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      throw new InvalidIdTokenError();
    }
    return payload;
  }

  return {
    async authorizationUrl({ state, nonce, challenge, idpHint }) {
      const { doc } = await discover();
      const url = new URL(doc.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: SCOPE,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(idpHint === undefined ? {} : { kc_idp_hint: idpHint }),
      }).toString();
      return url;
    },
    exchangeCode: ({ code, verifier, nonce }) =>
      tokenRequest(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        },
        nonce,
      ),
    refresh: (refreshToken) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, undefined),
    async endSessionUrl({ idToken }) {
      const { doc } = await discover();
      if (doc.end_session_endpoint === undefined) return undefined;
      const url = new URL(doc.end_session_endpoint);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        post_logout_redirect_uri: `${config.consoleOrigin}/`,
        ...(idToken === undefined ? {} : { id_token_hint: idToken }),
      }).toString();
      return url;
    },
    async verifyLogoutToken(token) {
      const { keys } = await discover();
      const payload = await verifyJwt(
        token,
        keys,
        ['iat', 'jti', 'events'],
        () => new InvalidLogoutTokenError(),
      );
      const events: unknown = payload.events;
      const isLogoutEvent =
        typeof events === 'object' &&
        events !== null &&
        BACKCHANNEL_LOGOUT_EVENT in events &&
        typeof (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT] === 'object';
      // A logout token is never an ID token: it must not carry a nonce.
      if (!isLogoutEvent || 'nonce' in payload) throw new InvalidLogoutTokenError();
      const sub = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : undefined;
      const sid = typeof payload.sid === 'string' && payload.sid !== '' ? payload.sid : undefined;
      if (sub === undefined && sid === undefined) throw new InvalidLogoutTokenError();
      const ageSeconds = deps.now() / MS_PER_SECOND - (payload.iat ?? 0);
      if (ageSeconds > LOGOUT_TOKEN_MAX_AGE_SECONDS || ageSeconds < -CLOCK_LEEWAY_SECONDS) {
        throw new InvalidLogoutTokenError();
      }
      if (typeof payload.jti !== 'string' || payload.jti === '')
        throw new InvalidLogoutTokenError();
      return { sub, sid, jti: payload.jti };
    },
  };
}
