import {
  RUN_ENVELOPE_MAX_BYTES,
  RUN_ENVELOPE_TYP,
  type RunEnvelope,
  runEnvelopeSchema,
} from '@blackwing/contracts';
import {
  canonicaliseValue,
  type EnvelopeSigningKey,
  envelopeHash,
  type JwsKeyResolver,
  signCanonicalJws,
  verifyJws,
} from '@blackwing/crypto';
import { AppError } from '@blackwing/errors';

/**
 * The approved run envelope (#399, §8.1, §8.9): build, canonicalise, sign and verify. Pure apart from the
 * signing key it is handed; the key lives in OpenBao Transit and only signatures come back. The egress
 * gateway re-implements verification in Go against the shared vectors under `packages/crypto/testvectors`.
 */

/**
 * Tolerance for clock skew between the approver's service and a verifier (`envelope.clockSkewSeconds`).
 * It widens the not-yet-valid check (a verifier whose clock lags must not reject a fresh approval) and
 * shrinks the expiry check (a verifier whose clock runs ahead expires the envelope early, never late).
 */
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;

const MS_PER_S = 1000;

/** An envelope that has been built, canonicalised and signed, ready to persist by reference. */
export interface SignedRunEnvelope {
  readonly envelope: RunEnvelope;
  /** Compact attached JWS over the canonical body. */
  readonly jws: string;
  /** Lowercase hex SHA-256 of the canonical body: the `envelopeHash` pinned on the run manifest (§8.9). */
  readonly envelopeHash: string;
  /** `<keyName>:v<N>`: the Transit version that signed, pinned on the run manifest. */
  readonly signingKeyId: string;
}

/**
 * Validates an envelope before it is signed. Identifier lists are sorted here, so every producer yields the same
 * canonical body for the same run; duplicates are refused by the schema. A body over the byte cap is refused
 * (fail closed). It refuses to sign at all when the standing authorisation has expired or the run window has
 * closed by `now`.
 */
export function buildRunEnvelope(draft: RunEnvelope, now: Date): RunEnvelope {
  const parsed = runEnvelopeSchema.safeParse({
    ...draft,
    assetIds: [...draft.assetIds].sort(),
    approvedTestCaseIds: [...draft.approvedTestCaseIds].sort(),
  });
  if (!parsed.success) {
    throw new AppError('ENVELOPE_VERIFICATION_FAILED', 'the run envelope is invalid', {
      detail: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
  }
  const envelope = parsed.data;
  const nowMs = now.getTime();
  if (Date.parse(envelope.saExpiresAt) <= nowMs) {
    throw new AppError('ENVELOPE_SA_EXPIRED', 'the standing authorisation has expired');
  }
  if (envelope.runWindowEndsAt !== null && Date.parse(envelope.runWindowEndsAt) <= nowMs) {
    throw new AppError('ENVELOPE_WINDOW_CLOSED', 'the run window has closed');
  }
  // Size is checked on the canonical bytes the signer would sign, so the cap is the real one.
  if (canonicaliseValue(envelope).byteLength > RUN_ENVELOPE_MAX_BYTES) {
    throw new AppError('ENVELOPE_TOO_LARGE', 'the run envelope is over its size cap');
  }
  return envelope;
}

/**
 * Signs a validated envelope: canonicalises it (RFC 8785), signs the bytes as an attached JWS with the
 * signing key and returns the hash and key id to pin. A signer failure propagates: nothing unsigned is returned.
 */
export async function signRunEnvelope(
  envelope: RunEnvelope,
  key: EnvelopeSigningKey,
): Promise<SignedRunEnvelope> {
  const parsed = runEnvelopeSchema.parse(envelope);
  const canonical = canonicaliseValue(parsed);
  const jws = await signCanonicalJws(canonical, key, RUN_ENVELOPE_TYP);
  return {
    envelope: parsed,
    jws,
    envelopeHash: envelopeHash(canonical),
    signingKeyId: key.kid,
  };
}

/** The `typ` the protected header of a token carries, read before verification (the signature checks it too). */
function headerTyp(token: string): unknown {
  const header = token.split('.')[0];
  if (header === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { typ?: unknown }).typ
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a run envelope token and returns the envelope it authorises, or throws. The signature, the key
 * (looked up by the pinned `kid`, so a rotated key still verifies older envelopes), the envelope type and the
 * schema must all hold. Then the time checks: the approval is not in the future (beyond the skew), and the
 * standing authorisation and the run window have not ended (shrunk by the skew).
 */
export function verifyRunEnvelope(
  jws: string,
  resolveKey: JwsKeyResolver,
  now: Date,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
): RunEnvelope {
  const invalid = (reason: string) =>
    new AppError('ENVELOPE_VERIFICATION_FAILED', 'the run envelope did not verify', {
      detail: reason,
    });
  if (headerTyp(jws) !== RUN_ENVELOPE_TYP) throw invalid('wrong envelope type');
  const verified = verifyJws(jws, resolveKey, RUN_ENVELOPE_MAX_BYTES);
  if (verified === null) throw invalid('signature, key or payload did not verify');
  const parsed = runEnvelopeSchema.safeParse(verified.payload);
  if (!parsed.success) throw invalid('payload does not match the run envelope schema');
  const envelope = parsed.data;

  const skewMs = clockSkewSeconds * MS_PER_S;
  const nowMs = now.getTime();
  if (Date.parse(envelope.approvedAt) > nowMs + skewMs) throw invalid('approval is in the future');
  if (Date.parse(envelope.saExpiresAt) - skewMs <= nowMs) {
    throw new AppError('ENVELOPE_SA_EXPIRED', 'the standing authorisation has expired');
  }
  if (envelope.runWindowEndsAt !== null && Date.parse(envelope.runWindowEndsAt) - skewMs <= nowMs) {
    throw new AppError('ENVELOPE_WINDOW_CLOSED', 'the run window has closed');
  }
  return envelope;
}
