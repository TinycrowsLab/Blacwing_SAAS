import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

import { Cron } from 'croner';

import { AppError, type AppErrorOptions } from '@blackwing/errors';
import { isValidTimeZone } from '@blackwing/time';

import { canonicaliseValue } from './jcs.js';
import { type Ed25519Jwk, SA_ENVELOPE_TYP, SA_JWS_ALG } from './jws.js';

import type { TestWindow } from '@blackwing/contracts';

/**
 * The canonical SA verifier (AUTHZ-005, #377, CONTEXT_PACK §8.1, §8.11). TypeScript half of the shared verifier; the Go
 * mirror (AUTHZ-006) must agree on the same vectors. Everything here is a pure function of its inputs: the clock is
 * passed in, and the JWKS is supplied by the caller (never fetched here), so the gateway can pin it.
 *
 * Fail closed throughout: an unknown key, a malformed token, an unapproved SA or an unreadable time zone never passes.
 */

/** Stable failure codes of {@link verifyEnvelope}. Callers log them and emit `authz_verify_total{ok,reason}`. */
export const SA_VERIFY_FAILURES = [
  'SIG_INVALID',
  'KID_UNKNOWN',
  'NOT_ACTIVE',
  'NOT_YET_VALID',
  'EXPIRED',
  'TAMPERED',
] as const;
export type VerifyFailure = (typeof SA_VERIFY_FAILURES)[number];

/** Stable codes for a test window that cannot be evaluated; such a window never opens (fail closed). */
export const WINDOW_FAILURES = ['WINDOW_TZ_INVALID', 'WINDOW_CRON_INVALID'] as const;
export type WindowFailure = (typeof WINDOW_FAILURES)[number];

/**
 * The signed body of a standing authorisation: exactly the fields the approval signs (AUTHZ-004). The JSON columns are
 * `unknown` because the canonicaliser accepts any I-JSON value; the layout itself is fixed by {@link saSignedBytes}.
 */
export interface SaSigningSource {
  readonly publicId: string;
  readonly assetIds: readonly string[];
  readonly scopeRules: unknown;
  readonly maxIntrusiveness: string;
  readonly preApprovedTestClasses: readonly string[];
  readonly defaultBudgets: unknown;
  readonly testWindows: readonly unknown[];
  readonly validFrom: Date;
  readonly expiresAt: Date;
  readonly requesterId: string;
}

/** The state the approval sets, which the signed body names. */
export interface SaApprovedState {
  readonly approverId: string;
  /** The version the row holds after the approval. */
  readonly version: number;
}

/** A stored standing authorisation as the verifier reads it: the signed body plus the approval columns. */
export interface VerifiableSa extends SaSigningSource {
  readonly status: string;
  readonly approverId: string | null;
  readonly version: number;
  /** Compact detached JWS (`header..signature`) over the canonical body. */
  readonly signature: string | null;
  readonly signingKeyId: string | null;
  /** Lowercase hex SHA-256 of the canonical body that was signed (§8.9). */
  readonly envelopeHash: string | null;
}

export interface VerifyOptions {
  /** Tolerance, in seconds, applied to the validity bounds only; never to the signature. Defaults to 0. */
  readonly clockSkewSeconds?: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Every failure found, in check order; empty when `ok`. */
  readonly reasons: readonly VerifyFailure[];
}

/** The canonical bytes an approval signs. The body is the JCS form of the fields listed here, with `status` fixed at `active`. */
export function saSignedBytes(source: SaSigningSource, approved: SaApprovedState): Uint8Array {
  return canonicaliseValue({
    saId: source.publicId,
    assetIds: [...source.assetIds],
    scopeRules: source.scopeRules,
    maxIntrusiveness: source.maxIntrusiveness,
    preApprovedTestClasses: [...source.preApprovedTestClasses],
    defaultBudgets: source.defaultBudgets,
    testWindows: [...source.testWindows],
    validFrom: source.validFrom.toISOString(),
    expiresAt: source.expiresAt.toISOString(),
    requesterId: source.requesterId,
    approverId: approved.approverId,
    status: 'active',
    version: approved.version,
  });
}

/** A standing authorisation that must not carry target traffic. `reason` is the first failure found. */
export class SaNotValidError extends AppError {
  declare readonly code: 'AUTHZ_SA_NOT_VALID';
  public readonly reason: VerifyFailure;

  public constructor(reason: VerifyFailure, options: AppErrorOptions = {}) {
    super('AUTHZ_SA_NOT_VALID', 'Standing authorisation is not valid for traffic', {
      detail: `The standing authorisation failed verification (${reason}).`,
      ...options,
    });
    this.name = 'SaNotValidError';
    this.reason = reason;
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A compact detached JWS is `header..signature`: three dot-separated parts with an empty payload. */
const JWS_PARTS = 3;
const ED25519_SIGNATURE_BYTES = 64;
const MS_PER_S = 1000;

function skewMs(options: VerifyOptions): number {
  const seconds = options.clockSkewSeconds ?? 0;
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError('verify: clockSkewSeconds must be a non-negative integer');
  }
  return seconds * MS_PER_S;
}

/** Validity-bound failures at `nowMs`. Half-open: the SA is valid on [validFrom, expiresAt). NaN fails closed. */
function validityFailures(sa: VerifiableSa, nowMs: number, skew: number): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  if (!(nowMs >= sa.validFrom.getTime() - skew)) failures.push('NOT_YET_VALID');
  if (!(nowMs < sa.expiresAt.getTime() + skew)) failures.push('EXPIRED');
  return failures;
}

/** `kid` and `alg` from a compact detached token's header, or `null` when the token is malformed. */
function parseDetached(
  compact: string,
): { readonly kid: string; readonly signature: Buffer; readonly header: string } | null {
  const parts = compact.split('.');
  if (parts.length !== JWS_PARTS || parts[1] !== '') return null;
  const [header, , sig] = parts as [string, string, string];
  if (!BASE64URL.test(header) || !BASE64URL.test(sig)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
    if (typeof head !== 'object' || head === null) return null;
    const { alg, kid, typ } = head as { alg?: unknown; kid?: unknown; typ?: unknown };
    if (alg !== SA_JWS_ALG || typ !== SA_ENVELOPE_TYP || typeof kid !== 'string') return null;
    const signature = Buffer.from(sig, 'base64url');
    if (signature.byteLength !== ED25519_SIGNATURE_BYTES) return null;
    return { kid, signature, header };
  } catch {
    return null;
  }
}

/** The public key for `kid` from the pinned JWKS, or `undefined` for an unknown or unusable key (fail closed). */
function keyFor(jwks: readonly Ed25519Jwk[], kid: string): KeyObject | undefined {
  const jwk = jwks.find((candidate) => candidate.kid === kid);
  // The JWKS is caller input, so its members are re-checked here rather than trusted from the type.
  const { alg, use, x } = (jwk ?? {}) as { alg?: unknown; use?: unknown; x?: unknown };
  if (jwk === undefined || alg !== SA_JWS_ALG || use !== 'sig' || typeof x !== 'string') {
    return undefined;
  }
  try {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x },
      format: 'jwk',
    });
  } catch {
    return undefined;
  }
}

/**
 * Verifies a stored SA: the canonical body is re-derived and must match the stored hash (TAMPERED); the detached JWS
 * must verify against the JWK for its `kid` (KID_UNKNOWN, SIG_INVALID); the status must be `active` (NOT_ACTIVE); and
 * `now` must lie in the validity bounds (NOT_YET_VALID, EXPIRED). Every failure is reported, so callers see the full
 * picture. `now` is injected: this function never reads the clock.
 */
export function verifyEnvelope(
  sa: VerifiableSa,
  jwks: readonly Ed25519Jwk[],
  now: Date,
  options: VerifyOptions = {},
): VerifyResult {
  const reasons: VerifyFailure[] = [];
  if (sa.status !== 'active') reasons.push('NOT_ACTIVE');
  reasons.push(...validityFailures(sa, now.getTime(), skewMs(options)));

  // An SA that was never approved has no signed body to check; that is a missing signature.
  if (sa.approverId === null || sa.signature === null || sa.signingKeyId === null) {
    reasons.push('SIG_INVALID');
    return { ok: false, reasons };
  }
  const bytes = saSignedBytes(sa, { approverId: sa.approverId, version: sa.version });
  const computedHash = createHash('sha256').update(bytes).digest('hex');
  if (sa.envelopeHash !== computedHash) {
    reasons.push('TAMPERED');
    return { ok: false, reasons };
  }

  const token = parseDetached(sa.signature);
  if (token?.kid !== sa.signingKeyId) {
    reasons.push('SIG_INVALID');
    return { ok: false, reasons };
  }
  const key = keyFor(jwks, token.kid);
  if (key === undefined) {
    reasons.push('KID_UNKNOWN');
    return { ok: false, reasons };
  }
  const signingInput = Buffer.from(
    `${token.header}.${Buffer.from(bytes).toString('base64url')}`,
    'ascii',
  );
  if (!verify(null, signingInput, key, token.signature)) reasons.push('SIG_INVALID');

  return { ok: reasons.length === 0, reasons };
}

/** True when the SA is `active` and `now` lies in its validity bounds. Does not check the signature; use {@link verifyEnvelope}. */
export function isActive(sa: VerifiableSa, now: Date, options: VerifyOptions = {}): boolean {
  return (
    sa.status === 'active' && validityFailures(sa, now.getTime(), skewMs(options)).length === 0
  );
}

/** Throws {@link SaNotValidError} with the first failure when the SA may not carry traffic. Used at traffic-decision points. */
export function assertValidForTraffic(
  sa: VerifiableSa,
  jwks: readonly Ed25519Jwk[],
  now: Date,
  options: VerifyOptions = {},
): void {
  const result = verifyEnvelope(sa, jwks, now, options);
  const first = result.reasons[0];
  if (!result.ok && first !== undefined) throw new SaNotValidError(first);
}

/** The window-check outcome: whether any window is open, and which windows could not be evaluated. */
export interface WindowCheck {
  readonly open: boolean;
  readonly invalid: readonly WindowFailure[];
}

function compileWindow(window: TestWindow): Cron | WindowFailure {
  if (!isValidTimeZone(window.timezone)) return 'WINDOW_TZ_INVALID';
  try {
    return new Cron(window.cron, { timezone: window.timezone, paused: true });
  } catch {
    return 'WINDOW_CRON_INVALID';
  }
}

/**
 * Whether any test window is open at `now`. A window `{cron, timezone, durationMs}` is open at `t` when its latest
 * opening at or before `t` is less than `durationMs` ago. The cron is evaluated on the wall clock of its IANA zone
 * (croner resolves DST), so the UTC instant moves with the zone's offset. An empty list is no window restriction, as in
 * the worker timeline: the SA's own validity still applies. An unevaluable window is closed and reported in `invalid`.
 */
export function checkTestWindows(testWindows: readonly TestWindow[], now: Date): WindowCheck {
  if (testWindows.length === 0) return { open: true, invalid: [] };
  const nowMs = now.getTime();
  let open = false;
  const invalid: WindowFailure[] = [];
  for (const window of testWindows) {
    const compiled = compileWindow(window);
    if (typeof compiled === 'string') {
      invalid.push(compiled);
      continue;
    }
    // The first opening strictly after `now - durationMs`; the window is open when it has already happened.
    const opening = compiled.nextRun(new Date(nowMs - window.durationMs));
    if (opening !== null && opening.getTime() <= nowMs) open = true;
  }
  return { open, invalid };
}

/** True when some test window is open at `now` (see {@link checkTestWindows}). */
export function inWindow(testWindows: readonly TestWindow[], now: Date): boolean {
  return checkTestWindows(testWindows, now).open;
}
