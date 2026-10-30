/**
 * Wire constants of the interactsh protocol this client speaks (OOB-002, #636). The server image is
 * pinned in `infra/compose/docker-compose.dev.yml` and `docs/runbooks/oob-server.md` (INFRA-010, #910);
 * bump them together. Every value here is either a protocol fact or a bound that keeps a hostile or broken
 * listener from exhausting memory.
 */

/** interactsh-server version this client was written against. `GET /` advertises it in `X-Interactsh-Version`. */
export const INTERACTSH_PROTOCOL_VERSION = '1.2.4';
/** Response header the server uses to advertise its version. */
export const INTERACTSH_VERSION_HEADER = 'x-interactsh-version';

/** Session RSA key size. The server encrypts each poll's AES key to this key (RSA-OAEP, SHA-256). */
export const RSA_MODULUS_BITS = 2048;
/** AES-256 key the server generates per poll batch; interactions are AES-256-CFB encrypted. */
export const AES_KEY_BYTES = 32;
/** CFB initialisation vector, prepended to every encrypted interaction record. */
export const AES_IV_BYTES = 16;

/** Correlation id length the server requires (lowercase DNS label characters). */
export const CORRELATION_ID_LENGTH = 20;
/**
 * Per-test nonce length. The listener only correlates a host whose first label is exactly the correlation id
 * followed by this nonce (20 + 13 = 33 characters); the per-test token is embedded at the start of the nonce.
 */
export const NONCE_LENGTH = 13;
/** Alphabet for correlation ids: lowercase letters and digits 2-7 (32 symbols, so bytes map without bias). */
export const CORRELATION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Hard cap on interaction records in one poll. The server clears a batch once it is returned, so an over-cap batch is an alarm, never a truncation. */
export const MAX_RECORDS_PER_POLL = 500;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MAX_RESPONSE_MIB = 16;
/** Hard cap on a poll or register response body, in bytes. */
export const MAX_RESPONSE_BYTES = MAX_RESPONSE_MIB * BYTES_PER_MIB;
/** Per-request timeout for every call to the listener. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Endpoint paths of the control API (relative to the server URL). */
export const ENDPOINTS = Object.freeze({
  root: '/',
  register: '/register',
  deregister: '/deregister',
  poll: '/poll',
});
