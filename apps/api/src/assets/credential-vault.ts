import type { Envelope, EnvelopeCrypto, SecretRotationService } from '@blackwing/secrets';

/**
 * The Secrets Service as the asset credential API uses it (#363, SECRETS-002/012). The API hands over plaintext once
 * and gets back only what it may store: a sealed envelope for a new credential, or the version a rotation produced.
 * A failure rejects, so the caller refuses the request with nothing persisted (fail closed).
 */
export interface CredentialVault {
  /** Seals the secret bundle of a new credential as the envelope of record `secretId`. */
  seal(input: { tenantId: string; secretId: string; plaintext: string }): Promise<Envelope>;
  /** Writes the next version of a credential's secret; resolves to the version the Secrets Service now serves. */
  rotate(input: { tenantId: string; secretId: string; plaintext: string }): Promise<number>;
}

/** The purpose every asset login secret is sealed under (part of the AAD, so it opens only for login use). */
export const ASSET_LOGIN_SECRET_PURPOSE = 'asset_login';

/**
 * The production vault: envelope encryption under the tenant KEK (`crypto`, SECRETS-002) and versioned rotation
 * (`rotation`, SECRETS-012). Plaintext is handed to the crypto and never kept or logged here.
 */
export function createSecretsCredentialVault(deps: {
  readonly crypto: Pick<EnvelopeCrypto, 'encryptSecret'>;
  readonly rotation: Pick<SecretRotationService, 'rotateSecret'>;
}): CredentialVault {
  return {
    seal: ({ tenantId, secretId, plaintext }) =>
      deps.crypto.encryptSecret({
        tenantId,
        plaintext,
        context: { secretId, purpose: ASSET_LOGIN_SECRET_PURPOSE },
      }),
    async rotate({ tenantId, secretId, plaintext }) {
      const result = await deps.rotation.rotateSecret({ tenantId, secretId, plaintext });
      return result.version;
    },
  };
}
