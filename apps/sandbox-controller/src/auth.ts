import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { type AuthFailureReason, SbxUnauthenticatedError } from './errors.js';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Run-scoped service tokens (`Authorization: Bearer bw_run_...`).
 *
 *   bw_run_<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "bw_run_" + payload))>
 *
 * Claims: `v` (format version, 1), `aud` (the service the token is for), `tid` (tenant UUID), `rid` (run
 * UUID), `iat` and `exp` (Unix seconds). The audience binds a token to one internal service, so a token
 * minted for the Run Broker cannot drive the sandbox controller. Verification is deterministic and fails
 * closed on every deviation (§8.2, §8.11); the token itself is never logged or echoed (§8.7).
 */
export const RUN_TOKEN_PREFIX = 'bw_run_';
export const SANDBOX_CONTROLLER_AUDIENCE = 'sandbox-controller';
/** Upper bound on the whole token; anything longer is refused before decoding. */
export const MAX_RUN_TOKEN_LENGTH = 2048;
/** Allowed clock skew for `iat` in the future, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;
/** Every `/internal/sandboxes/*` route requires a run token (and so does every unmatched path below it). */
export const PROTECTED_PREFIX = '/internal/sandboxes';

const SIGNATURE_BYTES = 32;
const MS_PER_SECOND = 1000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Tenant and run context attached to every authenticated internal request (§8.6). */
export interface RunContext {
  readonly tenantId: string;
  readonly runId: string;
  /** Token expiry, Unix seconds. */
  readonly expiresAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the run-token hook on `/internal/sandboxes/*`; `null` everywhere else. */
    runContext: RunContext | null;
  }
}

const claimsSchema = z.strictObject({
  v: z.literal(1),
  aud: z.string().min(1),
  tid: z.uuid(),
  rid: z.uuid(),
  iat: z.int().nonnegative(),
  exp: z.int().positive(),
});

export interface RunTokenVerifier {
  /** Returns the run context, or throws {@link SbxUnauthenticatedError}. Never throws anything else. */
  verify(authorization: string | undefined): RunContext;
}

export interface HmacRunTokenOptions {
  /** HMAC key (`SBX_RUN_TOKEN_SECRET`). */
  readonly secret: string;
  readonly audience?: string;
  /** Current time in milliseconds; injectable for tests. */
  readonly now?: () => number;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(`${RUN_TOKEN_PREFIX}${payload}`).digest();
}

function reject(reason: AuthFailureReason): never {
  throw new SbxUnauthenticatedError(reason);
}

/** HMAC-SHA256 verifier for `bw_run_` tokens. */
export function createHmacRunTokenVerifier(options: HmacRunTokenOptions): RunTokenVerifier {
  const audience = options.audience ?? SANDBOX_CONTROLLER_AUDIENCE;
  const now = options.now ?? Date.now;
  return {
    verify(authorization) {
      if (authorization === undefined || authorization === '') reject('missing');
      const match = /^Bearer ([^\s]+)$/i.exec(authorization);
      const token = match?.[1];
      if (token === undefined) reject('not_bearer');
      if (token.length > MAX_RUN_TOKEN_LENGTH) reject('too_long');
      if (!token.startsWith(RUN_TOKEN_PREFIX)) reject('wrong_prefix');
      const parts = token.slice(RUN_TOKEN_PREFIX.length).split('.');
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
      const expected = sign(options.secret, payload);
      if (given.length !== SIGNATURE_BYTES || !timingSafeEqual(given, expected)) {
        reject('bad_signature');
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        reject('bad_claims');
      }
      const parsed = claimsSchema.safeParse(raw);
      if (!parsed.success) reject('bad_claims');
      const claims = parsed.data;
      if (claims.aud !== audience) reject('wrong_audience');
      const nowSeconds = Math.floor(now() / MS_PER_SECOND);
      if (claims.exp <= nowSeconds) reject('expired');
      if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.iat >= claims.exp) {
        reject('not_yet_valid');
      }
      return Object.freeze({ tenantId: claims.tid, runId: claims.rid, expiresAt: claims.exp });
    },
  };
}

export interface RunTokenClaims {
  readonly tenantId: string;
  readonly runId: string;
  /** Unix seconds. */
  readonly expiresAt: number;
  /** Unix seconds; defaults to now. */
  readonly issuedAt?: number;
  readonly audience?: string;
}

/**
 * Mints a `bw_run_` token. The Run Controller (WORKFLOW) is the issuer; this lives next to the verifier so
 * the format has one definition.
 */
export function signRunToken(secret: string, claims: RunTokenClaims): string {
  const body = {
    v: 1,
    aud: claims.audience ?? SANDBOX_CONTROLLER_AUDIENCE,
    tid: claims.tenantId,
    rid: claims.runId,
    iat: claims.issuedAt ?? Math.floor(Date.now() / MS_PER_SECOND),
    exp: claims.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${RUN_TOKEN_PREFIX}${payload}.${sign(secret, payload).toString('base64url')}`;
}

/**
 * True for `/internal/sandboxes` and everything below it. The check is deliberately broader than the
 * router: the path is percent-decoded, repeated slashes are collapsed and case is ignored, so no spelling
 * the router might still match can slip past. An undecodable path counts as protected (fail closed).
 */
export function isProtectedPath(url: string): boolean {
  const raw = url.split('?', 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  const path = decoded.replaceAll(/\/+/g, '/').toLowerCase();
  return path === PROTECTED_PREFIX || path.startsWith(`${PROTECTED_PREFIX}/`);
}

export type AuthFailureListener = (request: FastifyRequest, reason: AuthFailureReason) => void;

/**
 * Registers the fail-closed run-token check. It runs in `onRequest`, before routing to a handler and
 * before the body is read, so an unauthenticated caller never gets a body parsed or a handler run.
 */
export function registerRunTokenAuth(
  app: FastifyInstance,
  verifier: RunTokenVerifier,
  onFailure?: AuthFailureListener,
): void {
  app.decorateRequest('runContext', null);
  app.addHook('onRequest', (request, _reply, done) => {
    if (!isProtectedPath(request.url)) {
      done();
      return;
    }
    try {
      request.runContext = verifier.verify(request.headers.authorization);
      done();
    } catch (error) {
      const reason = error instanceof SbxUnauthenticatedError ? error.reason : 'malformed';
      onFailure?.(request, reason);
      done(error instanceof SbxUnauthenticatedError ? error : new SbxUnauthenticatedError(reason));
    }
  });
}
