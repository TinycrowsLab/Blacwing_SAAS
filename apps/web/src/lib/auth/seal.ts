// Authenticated encryption for the BFF cookies and Valkey records (IAM-002, #334). The primitives live in
// `@blackwing/crypto` so the API opens the same session cookie and records with the same key derivation.
export { deriveKey, KEY_BYTES, MIN_SECRET_LENGTH, open, seal } from '@blackwing/crypto';
