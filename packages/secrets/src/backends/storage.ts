import { AppError } from '@blackwing/errors';

import type { ExternalLocator, ExternalStoreBackend, SecretBackendMode } from './types.js';
import type { SecretBackend } from '@blackwing/contracts';

/** The storage columns of one secret version. The two modes are mutually exclusive. */
export interface SecretStorageShape {
  readonly envelope: unknown;
  readonly externalLocator: ExternalLocator | null;
}

/**
 * Rejects a record whose storage contradicts its backend mode (issue #112 edge case: "record says external but
 * no locator" is invalid). Fails closed with `ENVELOPE_INVALID`; it never picks a different storage path.
 */
export function assertStorageShape(shape: SecretStorageShape, mode: SecretBackendMode): void {
  if (mode === 'external_store') {
    if (shape.externalLocator === null || shape.envelope !== null) {
      throw new AppError(
        'ENVELOPE_INVALID',
        'external_store secret must carry an external_locator and no envelope',
      );
    }
    return;
  }
  if (shape.envelope === null || shape.externalLocator !== null) {
    throw new AppError(
      'ENVELOPE_INVALID',
      'kek_wrap secret must carry an envelope and no external_locator',
    );
  }
}

/** The row Blackwing persists for an external secret: the locator only, never the value. */
export interface ExternalSecretRow {
  readonly backend: SecretBackend;
  readonly envelope: null;
  readonly externalLocator: ExternalLocator;
}

/**
 * Stores a value in the customer's store and returns the only row Blackwing may persist for it (§8.7). The
 * plaintext is handed to the backend and dropped; if `put` fails, no row is produced.
 */
export async function storeExternalSecret(
  backend: ExternalStoreBackend,
  tenantId: string,
  ref: string,
  value: Uint8Array | string,
): Promise<ExternalSecretRow> {
  const externalLocator = await backend.put(tenantId, ref, value);
  const row = { backend: backend.kind, envelope: null, externalLocator } as const;
  assertStorageShape(row, backend.mode);
  return row;
}
