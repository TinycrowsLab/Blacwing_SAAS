import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  BROKER_TOKEN_AUDIENCE,
  BROKER_TOKEN_MAX_TTL_SECONDS,
  BROKER_TOKEN_PREFIX,
  type BrokerPrincipal,
  type BrokerScope,
  brokerTokenClaimsSchema,
} from '@blackwing/contracts';
import { AuthError } from '@blackwing/errors';

/**
 * Run-scoped broker tokens (`Authorization: Bearer bwrun_...`), API-014 requirement 2.
 *
 *   bwrun_<base64url(JSON claims)>.<base64url(HMAC-SHA256(secret, "bwrun_" + payload))>
 *
 * Claims bind a token to one tenant, run and session, a scope list, and a short lifetime. Verification is
 * deterministic and fails closed on every deviation (§8.2, §8.11). Issuance wiring is owned by
 * RUNTIME/SANDBOX; {@link signBrokerToken} fixes the format in one place. The token never reaches a log,
 * a metric label or an error body (§8.7): failures carry only a coarse {@link BrokerAuthFailure}.
 */

/** Anything longer is refused before decoding. */
export const MAX_BROKER_TOKEN_LENGTH = 2048;
/** Allowed clock skew for an `iat` in the future, in seconds. */
export const BROKER_CLOCK_SKEW_SECONDS = 30;

const SIGNATURE_BYTES = 32;
const MS_PER_SECOND = 1000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Why a token was refused. Logged and counted; never shown to the caller. */
export type BrokerAuthFailure =
  | 'missing'
  | 'not_bearer'
  | 'too_long'
  | 'wrong_prefix'
  | 'malformed'
  | 'bad_signature'
  | 'bad_claims'
  | 'ttl_too_long'
  | 'expired'
  | 'not_yet_valid'
  | 'revoked';

/** A 401 for a missing, invalid, expired or revoked token. */
export class BrokerAuthError extends AuthError {
  readonly reason: BrokerAuthFailure;

  constructor(reason: BrokerAuthFailure) {
    super('invalid or missing run token', { detail: 'A valid run-scoped token is required.' });
    this.reason = reason;
  }
}

/**
 * Revoked tokens and runs. The kill switch (KILL) revokes by run: revocation takes effect on the next
 * check, which the broker repeats right before it acts (§8.5).
 */
export interface RunTokenRevocations {
  isRevoked(input: {
    readonly tokenId: string;
    readonly runId: string;
  }): boolean | Promise<boolean>;
}

// OFFLINE-STUB(online-porting #895): per-process revocation list; the shared store is Valkey-backed.
/** In-memory revocation list. The shared (Valkey-backed) store is wired by KILL/RUNTIME. */
export class InMemoryRunTokenRevocations implements RunTokenRevocations {
  private readonly tokens = new Set<string>();
  private readonly runs = new Set<string>();

  revokeToken(tokenId: string): void {
    this.tokens.add(tokenId);
  }

  revokeRun(runId: string): void {
    this.runs.add(runId);
  }

  isRevoked(input: { readonly tokenId: string; readonly runId: string }): boolean {
    return this.tokens.has(input.tokenId) || this.runs.has(input.runId);
  }
}

export interface BrokerTokenVerifier {
  /** Returns the principal, or throws {@link BrokerAuthError}. Never throws anything else. */
  verify(authorization: string | undefined): BrokerPrincipal;
}

export interface BrokerTokenVerifierOptions {
  readonly secret: string;
  /** Current time in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${BROKER_TOKEN_PREFIX}${payload}`).digest();
}

function reject(reason: BrokerAuthFailure): never {
  throw new BrokerAuthError(reason);
}

/** HMAC-SHA256 verifier for `bwrun_` tokens (revocation is checked separately, per request). */
export function createBrokerTokenVerifier(
  options: BrokerTokenVerifierOptions,
): BrokerTokenVerifier {
  const now = options.now ?? Date.now;
  return {
    verify(authorization) {
      if (authorization === undefined || authorization === '') reject('missing');
      const match = /^Bearer ([^\s]+)$/i.exec(authorization);
      const token = match?.[1];
      if (token === undefined) reject('not_bearer');
      if (token.length > MAX_BROKER_TOKEN_LENGTH) reject('too_long');
      if (!token.startsWith(BROKER_TOKEN_PREFIX)) reject('wrong_prefix');
      const parts = token.slice(BROKER_TOKEN_PREFIX.length).split('.');
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
      if (
        given.length !== SIGNATURE_BYTES ||
        !timingSafeEqual(given, sign(options.secret, payload))
      ) {
        reject('bad_signature');
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        reject('bad_claims');
      }
      const parsed = brokerTokenClaimsSchema.safeParse(raw);
      if (!parsed.success) reject('bad_claims');
      const claims = parsed.data;
      if (claims.exp - claims.iat > BROKER_TOKEN_MAX_TTL_SECONDS) reject('ttl_too_long');
      const nowSeconds = Math.floor(now() / MS_PER_SECOND);
      if (claims.exp <= nowSeconds) reject('expired');
      if (claims.iat > nowSeconds + BROKER_CLOCK_SKEW_SECONDS || claims.iat >= claims.exp) {
        reject('not_yet_valid');
      }
      return Object.freeze({
        tokenId: claims.jti,
        tenantId: claims.tid,
        runId: claims.rid,
        sessionId: claims.sid,
        scopes: Object.freeze([...claims.scp]),
        expiresAt: claims.exp,
      });
    },
  };
}

export interface SignBrokerTokenInput {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly scopes: readonly BrokerScope[];
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Unix seconds; defaults to now. */
  readonly issuedAt?: number;
}

/** Mints a `bwrun_` token. The runtime (RUNTIME/SANDBOX) is the issuer; the format lives here once. */
export function signBrokerToken(secret: string, input: SignBrokerTokenInput): string {
  const body = {
    v: 1,
    aud: BROKER_TOKEN_AUDIENCE,
    jti: input.tokenId,
    tid: input.tenantId,
    rid: input.runId,
    sid: input.sessionId,
    scp: [...input.scopes],
    iat: input.issuedAt ?? Math.floor(Date.now() / MS_PER_SECOND),
    exp: input.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${BROKER_TOKEN_PREFIX}${payload}.${sign(secret, payload).toString('base64url')}`;
}
