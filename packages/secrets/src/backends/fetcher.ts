import { AppError } from '@blackwing/errors';

import { assertStorageShape } from './storage.js';

import type { ExternalSecretFetcher, SecretRecord } from '../resolve.js';
import type { SecretBackendRegistry } from './registry.js';

/**
 * The SECRETS-006 resolver's external path, routed by backend mode instead of by a hard-coded kind. Only an
 * `external_store` backend can supply a value; a `kek_wrap` backend never holds plaintext to return.
 */
export function createRegistryFetcher(registry: SecretBackendRegistry): ExternalSecretFetcher {
  return {
    async fetch(record: SecretRecord) {
      const backend = await registry.resolveHealthy(record.backend);
      if (backend.mode !== 'external_store') {
        throw new AppError('EXTERNAL_BACKEND_UNAVAILABLE', 'backend holds no customer-owned store');
      }
      assertStorageShape(record, backend.mode);
      if (record.externalLocator === null) {
        throw new AppError('ENVELOPE_INVALID', 'external secret has no locator');
      }
      return backend.get(record.tenantId, record.externalLocator);
    },
  };
}
