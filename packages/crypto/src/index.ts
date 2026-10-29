/** Workspace package name of this package. */
export const name = '@blackwing/crypto';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { deriveKey, KEY_BYTES, MIN_SECRET_LENGTH, open, seal } from './seal.js';
export { type JwsKeyResolver, type JwsSigner, publicKeyOf, signJws, verifyJws } from './jws.js';
export {
  canonicalHash,
  canonicalise,
  canonicaliseValue,
  CanonicalisationError,
  CRYPTO_NONFINITE_NUMBER,
  jcs,
} from './jcs.js';
