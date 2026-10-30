/** Workspace package name of this package. */
export const name = '@blackwing/crypto';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  EVIDENCE_GENESIS_CHAIN,
  type EvidenceChainLinkInput,
  evidenceChainLink,
  sha256Hex,
} from './evidence-chain.js';
export { deriveKey, KEY_BYTES, MIN_SECRET_LENGTH, open, seal } from './seal.js';
export {
  type DetachedJws,
  type Ed25519Jwk,
  type EnvelopeSigningKey,
  ed25519Jwk,
  envelopeHash,
  type JwsKeyResolver,
  type JwsSigner,
  publicKeyOf,
  SA_ENVELOPE_TYP,
  SA_JWS_ALG,
  signCanonicalJws,
  signEnvelope,
  signJws,
  verifyJws,
} from './jws.js';
export {
  canonicalHash,
  canonicalise,
  canonicaliseValue,
  CanonicalisationError,
  CRYPTO_NONFINITE_NUMBER,
  jcs,
} from './jcs.js';
