import { createHash, randomBytes } from 'node:crypto';

import { SIGNUP_TOKEN_BYTES } from '@blackwing/contracts';

/** A fresh 256-bit verification token, base64url without padding (43 characters). */
export function newSignupToken(): string {
  return randomBytes(SIGNUP_TOKEN_BYTES).toString('base64url');
}

/**
 * Lower-case hex SHA-256 of a token: the only form that is stored or compared (§8.7). The token is 256
 * random bits, so a fast hash is enough: there is nothing to brute-force.
 */
export function hashSignupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const LOG_REF_HEX = 12;

/** A short, non-reversible label for an e-mail address in logs (§5: never the address itself). */
export function logRef(value: string): string {
  return createHash('sha256')
    .update(value.toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, LOG_REF_HEX);
}
