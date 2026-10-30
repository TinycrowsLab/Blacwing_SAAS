import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import { kekKeyName, type TenantKekService } from '../kek.js';
import {
  assertTenantId,
  type BackendHealth,
  type BackendTelemetry,
  type KekWrapBackend,
  observe,
  parseBackendConfig,
} from './types.js';

import type { OpenBaoClient } from '../openbao.js';
import type { TransitClient } from '../transit.js';

const DEK_BYTES = 32;
const HTTP_OK = 200;
/** Transit ciphertext: `vault:vN:<base64>`. Anything else is not a wrapped DEK. */
const WRAPPED_DEK = /^vault:v[1-9][0-9]{0,9}:[A-Za-z0-9+/]+=*$/;
const KIND = 'openbao';

export interface OpenBaoBackendDeps {
  readonly transit: TransitClient;
  /** Only `sys/health` is read; the tenant KEK lifecycle stays in {@link TenantKekService}. */
  readonly client: Pick<OpenBaoClient, 'request'>;
  /** A disabled tenant KEK refuses every wrap and unwrap (SECRETS-013 shred path). */
  readonly kek: Pick<TenantKekService, 'isTenantKekDisabled'>;
  readonly telemetry?: BackendTelemetry;
}

/** OpenBao Transit as the default `kek_wrap` backend (SECRETS-001/002). Keys are tenant-scoped by name. */
export function createOpenBaoBackend(deps: OpenBaoBackendDeps): KekWrapBackend {
  const { transit, client, kek } = deps;
  const telemetry = deps.telemetry ?? {};
  // OpenBao addressing comes from the typed env at boot; the backend itself has no per-tenant config.
  const configSchema = z.object({}).strict();

  async function refuseIfDisabled(tenantId: string): Promise<void> {
    if (await kek.isTenantKekDisabled(tenantId)) {
      throw new AppError('KEK_DISABLED', 'tenant KEK is disabled');
    }
  }

  const health = (): Promise<BackendHealth> =>
    observe(telemetry, KIND, 'health', async () => {
      try {
        const res = await client.request('GET', 'sys/health');
        return res.status === HTTP_OK
          ? { healthy: true }
          : { healthy: false, reason: `sys/health status ${res.status}` };
      } catch {
        return { healthy: false, reason: 'sys/health unreachable' };
      }
    });

  return {
    kind: KIND,
    mode: 'kek_wrap',
    configSchema,
    validate: (config) => {
      parseBackendConfig(configSchema, config);
    },
    health,
    async testAccess() {
      if (!(await health()).healthy) {
        throw new AppError('KEK_UNAVAILABLE', 'OpenBao is not reachable or not unsealed');
      }
    },
    async wrapDek(tenantId, dek) {
      assertTenantId(tenantId);
      if (dek.byteLength !== DEK_BYTES) {
        throw new AppError('VALIDATION_FAILED', 'DEK must be 32 bytes');
      }
      return observe(telemetry, KIND, 'wrap', async () => {
        await refuseIfDisabled(tenantId);
        return transit.encrypt(kekKeyName(tenantId), Buffer.from(dek).toString('base64'));
      });
    },
    async unwrapDek(tenantId, wrapped) {
      assertTenantId(tenantId);
      if (!WRAPPED_DEK.test(wrapped)) {
        throw new AppError('ENVELOPE_INVALID', 'wrapped DEK is not Transit ciphertext');
      }
      return observe(telemetry, KIND, 'unwrap', async () => {
        await refuseIfDisabled(tenantId);
        const dek = Buffer.from(await transit.decrypt(kekKeyName(tenantId), wrapped), 'base64');
        if (dek.byteLength !== DEK_BYTES) {
          throw new AppError('SECRET_DECRYPT_FAILED', 'unwrapped DEK has the wrong length');
        }
        return dek;
      });
    },
  };
}
