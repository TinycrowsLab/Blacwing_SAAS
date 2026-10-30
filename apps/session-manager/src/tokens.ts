import { createHmac, timingSafeEqual } from 'node:crypto';

import { type AuthFailureReason, SmUnauthenticatedError } from './errors.js';

/**
 * Session-manager service tokens. Two classes share one format and differ in prefix, key and claims:
 *
 *   <prefix><base64url(JSON claims)>.<base64url(HMAC-SHA256(key, prefix + payload))>
 *
 * - run-scoped `bw_run_` (injection and validity reads inside one run): claims carry `tid` and `rid`.
 * - control-plane `bw_ctl_` (setup and preflight for one tenant): claims carry `tid` only.
 *
 * Claims: `v` (format version 1), `aud` (always `session-manager`, so a token minted for another internal
 * service is refused), `tid`, optional `rid`, `iat` and `exp` (Unix seconds). Each class has its own HMAC key,
 * so a leaked run key cannot mint control-plane tokens. Verification is deterministic and fails closed on every
 * deviation; the token is never logged or echoed (S8.7).
 */
export const RUN_TOKEN_PREFIX = 'bw_run_';
export const CONTROL_TOKEN_PREFIX = 'bw_ctl_';
export const SESSION_MANAGER_AUDIENCE = 'session-manager';
/** Upper bound on the whole token; anything longer is refused before decoding. */
const MAX_TOKEN_LENGTH = 2048;
/** Allowed clock skew for `iat` in the future, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;

const SIGNATURE_BYTES = 32;
const MS_PER_SECOND = 1000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A verified caller. `runId` is set only for run-scoped tokens. */
export interface Principal {
  readonly kind: 'run' | 'control';
  readonly tenantId: string;
  readonly runId?: string;
  /** Token expiry, Unix seconds. */
  readonly expiresAt: number;
}

export interface TokenVerifier {
  /** Returns the principal, or throws {@link SmUnauthenticatedError}. Never throws anything else. */
  verify(authorization: string | undefined): Principal;
}

export interface TokenVerifierOptions {
  readonly runSecret: string;
  readonly controlSecret: string;
  /** Current time in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

interface TokenClass {
  readonly prefix: string;
  readonly secret: string;
  readonly kind: Principal['kind'];
}

function reject(reason: AuthFailureReason): never {
  throw new SmUnauthenticatedError(reason);
}

function sign(secret: string, prefix: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${prefix}${payload}`).digest();
}

function decodeClaims(payload: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return reject('bad_claims');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) reject('bad_claims');
  return raw as Record<string, unknown>;
}

/** A run-scoped token must name a UUID run; a control-plane token must not name one at all. */
function runIdOf(rid: unknown): string {
  if (typeof rid !== 'string' || !UUID.test(rid)) reject('bad_claims');
  return rid;
}

/** Checks the claims and returns the principal for the token class. */
function principalOf(
  claims: Record<string, unknown>,
  tokenClass: TokenClass,
  nowSeconds: number,
): Principal {
  const { v, aud, tid, rid, iat, exp } = claims;
  if (v !== 1 || typeof tid !== 'string' || !UUID.test(tid)) reject('bad_claims');
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= 0) reject('bad_claims');
  if (typeof iat !== 'number' || !Number.isSafeInteger(iat)) reject('bad_claims');
  if (aud !== SESSION_MANAGER_AUDIENCE) reject('wrong_audience');
  if (exp <= nowSeconds) reject('expired');
  if (iat < 0 || iat > nowSeconds + CLOCK_SKEW_SECONDS || iat >= exp) reject('not_yet_valid');
  if (tokenClass.kind === 'control') {
    if (rid !== undefined) reject('bad_claims');
    return Object.freeze({ kind: 'control', tenantId: tid, expiresAt: exp });
  }
  return Object.freeze({
    kind: 'run',
    tenantId: tid,
    runId: runIdOf(rid),
    expiresAt: exp,
  });
}

/**
 * HMAC verifier for both token classes. The prefix selects the class (and so the key and the claim shape);
 * an unknown prefix is refused before any decoding.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const now = options.now ?? Date.now;
  const classes: readonly TokenClass[] = [
    { prefix: RUN_TOKEN_PREFIX, secret: options.runSecret, kind: 'run' },
    { prefix: CONTROL_TOKEN_PREFIX, secret: options.controlSecret, kind: 'control' },
  ];
  return {
    verify(authorization) {
      if (authorization === undefined || authorization === '') reject('missing');
      const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
      if (token === undefined) reject('not_bearer');
      if (token.length > MAX_TOKEN_LENGTH) reject('too_long');
      const tokenClass = classes.find((candidate) => token.startsWith(candidate.prefix));
      if (tokenClass === undefined) reject('wrong_prefix');
      const parts = token.slice(tokenClass.prefix.length).split('.');
      const [payload, signature] = parts;
      if (
        parts.length !== 2 ||
        payload === undefined ||
        signature === undefined ||
        !BASE64URL.test(payload) ||
        !BASE64URL.test(signature)
      ) {
        reject('malformed');
      }
      const given = Buffer.from(signature, 'base64url');
      const expected = sign(tokenClass.secret, tokenClass.prefix, payload);
      if (given.length !== SIGNATURE_BYTES || !timingSafeEqual(given, expected)) {
        reject('bad_signature');
      }
      const claims = decodeClaims(payload);
      return principalOf(claims, tokenClass, Math.floor(now() / MS_PER_SECOND));
    },
  };
}

export interface TokenClaims {
  readonly tenantId: string;
  /** Required for run-scoped tokens; omitted for control-plane tokens. */
  readonly runId?: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Unix seconds; defaults to now. */
  readonly issuedAt?: number;
}

/** Mints a run-scoped `bw_run_` token. The Run Controller is the issuer; the format is defined here. */
export function signRunToken(secret: string, claims: TokenClaims): string {
  if (claims.runId === undefined) throw new SmUnauthenticatedError('malformed');
  return mint(secret, RUN_TOKEN_PREFIX, { tid: claims.tenantId, rid: claims.runId }, claims);
}

/** Mints a control-plane `bw_ctl_` token for one tenant. */
export function signControlToken(secret: string, claims: TokenClaims): string {
  return mint(secret, CONTROL_TOKEN_PREFIX, { tid: claims.tenantId }, claims);
}

function mint(
  secret: string,
  prefix: string,
  scope: { readonly tid: string; readonly rid?: string },
  claims: TokenClaims,
): string {
  const body = {
    v: 1,
    aud: SESSION_MANAGER_AUDIENCE,
    ...scope,
    iat: claims.issuedAt ?? Math.floor(Date.now() / MS_PER_SECOND),
    exp: claims.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${prefix}${payload}.${sign(secret, prefix, payload).toString('base64url')}`;
}
