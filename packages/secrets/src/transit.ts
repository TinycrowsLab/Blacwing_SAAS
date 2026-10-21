import { AppError } from '@blackwing/errors';

import type { OpenBaoClient } from './openbao.js';

/** The three Transit operations envelope encryption needs; values are Vault-format text. */
export interface TransitClient {
  /** `transit/encrypt/:key`: returns `vault:vN:...` ciphertext of the base64 `plaintext`. */
  encrypt(key: string, plaintextB64: string): Promise<string>;
  /** `transit/decrypt/:key`: returns the base64 plaintext. Rejects `KEK_DISABLED` for a shredded version. */
  decrypt(key: string, ciphertext: string): Promise<string>;
  /** `transit/rewrap/:key`: returns the ciphertext wrapped under the key's newest version. */
  rewrap(key: string, ciphertext: string): Promise<string>;
}

/** Transit operations over the SECRETS-001 OpenBao client. A missing key or odd response fails closed. */
export function createTransit(client: OpenBaoClient): TransitClient {
  async function call(
    op: 'encrypt' | 'decrypt' | 'rewrap',
    key: string,
    body: Record<string, string>,
  ): Promise<string> {
    const res = await client.request('POST', `transit/${op}/${encodeURIComponent(key)}`, body);
    const value = res.data?.[op === 'decrypt' ? 'plaintext' : 'ciphertext'];
    if (typeof value !== 'string') {
      throw new AppError(
        'KEK_UNAVAILABLE',
        `transit ${op} returned no result (status ${res.status})`,
      );
    }
    return value;
  }
  return {
    encrypt: (key, plaintext) => call('encrypt', key, { plaintext }),
    decrypt: (key, ciphertext) => call('decrypt', key, { ciphertext }),
    rewrap: (key, ciphertext) => call('rewrap', key, { ciphertext }),
  };
}
