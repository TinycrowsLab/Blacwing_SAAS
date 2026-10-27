import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppError } from '@blackwing/errors';

/**
 * Service identity of the internal secret resolve API (SECRETS-006, §8.7, §8.11).
 *
 * The caller presents `Authorization: Bearer bwsvc_<base64url(JSON claims)>.<base64url(HMAC-SHA256)>`.
 * The claims name one platform service, a token id and a short lifetime. Verification is deterministic
 * and fails closed on every deviation with `SERVICE_AUTH_FAILED`; the coarse reason stays server-side.
 * Authentication only says WHO is calling: what the caller may resolve is {@link DEFAULT_SERVICE_MATRIX}.
 */

/** The only services that may resolve a secret. */
export const SECRET_SERVICES = [
  'session-manager',
  'egress-gateway',
  'model-gateway',
  'worker:connectors',
  'worker:notify',
] as const;
export type SecretService = (typeof SECRET_SERVICES)[number];

const SERVICE_TOKEN_PREFIX = 'bwsvc_';
const SERVICE_TOKEN_AUDIENCE = 'secrets.resolve';
/** Service tokens are rotated at least daily. */
export const SERVICE_TOKEN_MAX_TTL_SECONDS = 86_400;
/** Anything longer is refused before decoding. */
const MAX_SERVICE_TOKEN_LENGTH = 1024;
/** Allowed clock skew for an `iat` in the future, in seconds. */
const SERVICE_CLOCK_SKEW_SECONDS = 30;

const MIN_KEY_LENGTH = 32;
const SIGNATURE_BYTES = 32;
const MS_PER_SECOND = 1000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Printable ASCII, as the audit ledger requires of a token id. */
const TOKEN_ID = /^[\x21-\x7e]{1,128}$/;

/** Why a token was refused. Logged and counted; never shown to the caller. */
export type ServiceAuthFailure =
  | 'missing'
  | 'not_bearer'
  | 'too_long'
  | 'wrong_prefix'
  | 'malformed'
  | 'bad_signature'
  | 'bad_claims'
  | 'unknown_service'
  | 'ttl_too_long'
  | 'expired'
  | 'not_yet_valid'
  | 'revoked';

/** `SERVICE_AUTH_FAILED` (401). Only the coarse {@link ServiceAuthFailure} is kept, never the token. */
export class ServiceAuthError extends AppError {
  declare readonly code: 'SERVICE_AUTH_FAILED';
  readonly reason: ServiceAuthFailure;

  constructor(reason: ServiceAuthFailure) {
    super('SERVICE_AUTH_FAILED', `service authentication failed: ${reason}`, {
      detail: 'A valid service token is required.',
    });
    this.reason = reason;
  }
}

/** An authenticated caller. */
export interface ServiceIdentity {
  readonly service: SecretService;
  readonly tokenId: string;
}

/** Revoked service tokens; an expired or revoked token is rejected on the next call. */
export interface ServiceTokenRevocations {
  isRevoked(tokenId: string): boolean | Promise<boolean>;
}

export interface ServiceTokenVerifierOptions {
  /** HMAC key shared with the issuer; at least 32 characters. */
  readonly key: string;
  readonly revocations?: ServiceTokenRevocations;
  /** Current time in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export interface ServiceTokenVerifier {
  /** Returns the identity, or rejects with {@link ServiceAuthError}. Never rejects with anything else. */
  verify(authorization: string | undefined): Promise<ServiceIdentity>;
}

function mac(key: string, payload: string): Buffer {
  return createHmac('sha256', key).update(`${SERVICE_TOKEN_PREFIX}${payload}`).digest();
}

function reject(reason: ServiceAuthFailure): never {
  throw new ServiceAuthError(reason);
}

const isService = (value: unknown): value is SecretService =>
  typeof value === 'string' && (SECRET_SERVICES as readonly string[]).includes(value);

const isSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function createServiceTokenVerifier(
  options: ServiceTokenVerifierOptions,
): ServiceTokenVerifier {
  if (options.key.length < MIN_KEY_LENGTH) {
    throw new AppError('CONFIG_INVALID', 'the service token key must be at least 32 characters');
  }
  const now = options.now ?? Date.now;
  return {
    async verify(authorization) {
      try {
        if (authorization === undefined || authorization === '') reject('missing');
        const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
        if (token === undefined) reject('not_bearer');
        if (token.length > MAX_SERVICE_TOKEN_LENGTH) reject('too_long');
        if (!token.startsWith(SERVICE_TOKEN_PREFIX)) reject('wrong_prefix');
        const parts = token.slice(SERVICE_TOKEN_PREFIX.length).split('.');
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
          !timingSafeEqual(given, mac(options.key, payload))
        ) {
          reject('bad_signature');
        }
        let claims: unknown;
        try {
          claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
          return reject('bad_claims');
        }
        if (typeof claims !== 'object' || claims === null) reject('bad_claims');
        const { v, aud, svc, jti, iat, exp } = claims as Record<string, unknown>;
        if (
          v !== 1 ||
          aud !== SERVICE_TOKEN_AUDIENCE ||
          typeof jti !== 'string' ||
          !TOKEN_ID.test(jti) ||
          !isSeconds(iat) ||
          !isSeconds(exp)
        ) {
          reject('bad_claims');
        }
        if (!isService(svc)) reject('unknown_service');
        if (exp - iat > SERVICE_TOKEN_MAX_TTL_SECONDS) reject('ttl_too_long');
        const nowSeconds = Math.floor(now() / MS_PER_SECOND);
        if (exp <= nowSeconds) reject('expired');
        if (iat > nowSeconds + SERVICE_CLOCK_SKEW_SECONDS || iat >= exp) reject('not_yet_valid');
        if ((await options.revocations?.isRevoked(jti)) === true) reject('revoked');
        return { service: svc, tokenId: jti };
      } catch (error) {
        // A revocation store that fails must not let a token through.
        throw error instanceof ServiceAuthError ? error : new ServiceAuthError('revoked');
      }
    },
  };
}

export interface SignServiceTokenInput {
  readonly service: SecretService;
  readonly tokenId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Unix seconds; defaults to now. */
  readonly issuedAt?: number;
}

/** Mints a service token. The deployment tooling is the issuer; the format lives here once. */
export function signServiceToken(key: string, input: SignServiceTokenInput): string {
  const body = {
    v: 1,
    aud: SERVICE_TOKEN_AUDIENCE,
    svc: input.service,
    jti: input.tokenId,
    iat: input.issuedAt ?? Math.floor(Date.now() / MS_PER_SECOND),
    exp: input.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${SERVICE_TOKEN_PREFIX}${payload}.${mac(key, payload).toString('base64url')}`;
}
