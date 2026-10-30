import { SECRET_BACKENDS, type SecretBackend } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import type { SecretBackendImpl } from './types.js';

export const DEFAULT_SECRET_BACKEND: SecretBackend = 'openbao';

export interface SecretBackendRegistryDeps {
  readonly backends: readonly SecretBackendImpl[];
  /** The backend a tenant without an explicit choice resolves to. Default `openbao` (`kek_wrap`). */
  readonly defaultKind?: SecretBackend;
}

export interface SecretBackendRegistry {
  /** Resolves a `secrets.backend` value. Unknown kinds fail with `UNKNOWN_SECRET_BACKEND`. */
  resolve(kind: string): SecretBackendImpl;
  resolveDefault(): SecretBackendImpl;
  /**
   * Resolves and probes health before any use. An unhealthy backend fails closed: the call never falls
   * back to another backend or another tenant's material.
   */
  resolveHealthy(kind: string): Promise<SecretBackendImpl>;
  readonly kinds: readonly SecretBackend[];
}

/** Builds the registry once at boot. Duplicate kinds or a default that is not registered are config defects. */
export function createBackendRegistry(deps: SecretBackendRegistryDeps): SecretBackendRegistry {
  const defaultKind = deps.defaultKind ?? DEFAULT_SECRET_BACKEND;
  const byKind = new Map<string, SecretBackendImpl>();
  const kinds: SecretBackend[] = [];
  for (const backend of deps.backends) {
    if (!(SECRET_BACKENDS as readonly string[]).includes(backend.kind)) {
      throw new AppError('CONFIG_INVALID', 'secret backend kind is not a contract kind');
    }
    if (byKind.has(backend.kind)) {
      throw new AppError(
        'CONFIG_INVALID',
        `duplicate secret backend registration: ${backend.kind}`,
      );
    }
    byKind.set(backend.kind, backend);
    kinds.push(backend.kind);
  }
  if (!byKind.has(defaultKind)) {
    throw new AppError('CONFIG_INVALID', `default secret backend ${defaultKind} is not registered`);
  }

  const resolve = (kind: string): SecretBackendImpl => {
    const backend = byKind.get(kind);
    if (backend === undefined) {
      throw new AppError('UNKNOWN_SECRET_BACKEND', 'no adapter is registered for this backend');
    }
    return backend;
  };

  return {
    resolve,
    resolveDefault: () => resolve(defaultKind),
    async resolveHealthy(kind) {
      const backend = resolve(kind);
      let healthy = false;
      try {
        healthy = (await backend.health()).healthy;
      } catch {
        healthy = false;
      }
      if (!healthy) {
        throw new AppError(
          backend.mode === 'kek_wrap' ? 'KEK_UNAVAILABLE' : 'EXTERNAL_BACKEND_UNAVAILABLE',
          `secret backend ${kind} is unavailable`,
        );
      }
      return backend;
    },
    kinds,
  };
}
