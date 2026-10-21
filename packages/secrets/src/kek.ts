import { AppError } from '@blackwing/errors';

import type { OpenBaoClient } from './openbao.js';

/** Transit mount and key-name scheme: one key per tenant, `tenant-{tenantId}`. */
const TRANSIT_MOUNT = 'transit';
const KEK_KEY_TYPE = 'aes256-gcm96';

/** Tenant ids become part of a Transit path and a policy glob, so only a conservative alphabet passes. */
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** `tenant-{tenantId}`; rejects ids that could address another key or path (traversal, wildcard). */
export function kekKeyName(tenantId: string): string {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
    throw new AppError('VALIDATION_FAILED', 'invalid tenant id for a KEK name');
  }
  return `tenant-${tenantId}`;
}

export type KekAuditAction =
  'secret.kek_provisioned' | 'secret.kek_rotated' | 'secret.kek_disabled';

/** What the service reports for §8.8; metadata is key name and version only, never key material. */
export interface KekAuditEvent {
  readonly tenantId: string;
  readonly action: KekAuditAction;
  readonly metadata: { readonly keyName: string; readonly version: number };
}

export interface KekMetrics {
  /** `kek_provision_total{result}` */
  provision(result: 'created' | 'exists' | 'error'): void;
  /** `kek_rotate_total` */
  rotate(result: 'ok' | 'error'): void;
}

export interface TenantKekServiceDeps {
  readonly client: OpenBaoClient;
  /** Required: an unaudited lifecycle change must not happen, so a rejecting sink fails the call. */
  readonly audit: (event: KekAuditEvent) => Promise<void>;
  readonly metrics?: KekMetrics;
  /** Wraps each OpenBao call group in the `openbao.transit` span. */
  readonly span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface KekInfo {
  readonly keyName: string;
  readonly latestVersion: number;
  readonly minDecryptionVersion: number;
}

export interface TenantKekService {
  /** Idempotent: creates the non-exportable key when absent; a no-op (and no audit) when present. */
  ensureTenantKek(tenantId: string): Promise<KekInfo & { readonly created: boolean }>;
  /** New key version; older versions stay available to decrypt until shred. */
  rotateTenantKek(tenantId: string): Promise<KekInfo>;
  getKekMinVersion(tenantId: string): Promise<number>;
  /** Raises the oldest version that may decrypt (rewrap support). */
  setKekMinDecryptVersion(tenantId: string, version: number): Promise<KekInfo>;
  /**
   * Blocks all further decrypt with existing ciphertext: marks the tenant disabled, rotates and
   * raises the minimum decrypt version past every version that ever held data. Always disable before
   * deleting the key (SECRETS-013), so an in-flight decrypt fails closed instead of racing a delete.
   */
  disableTenantKek(tenantId: string): Promise<KekInfo>;
  /** True once {@link disableTenantKek} completed. Callers that encrypt must refuse when true. */
  isTenantKekDisabled(tenantId: string): Promise<boolean>;
}

const noopMetrics: KekMetrics = { provision: () => undefined, rotate: () => undefined };
const defaultSpan = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();
const statePath = (tenantId: string): string => `secret/data/platform/kek-state/${tenantId}`;

export function createTenantKekService(deps: TenantKekServiceDeps): TenantKekService {
  const { client, audit } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  const span = deps.span ?? defaultSpan;
  const traced = <T>(fn: () => Promise<T>): Promise<T> => span('openbao.transit', fn);

  async function readKey(keyName: string): Promise<KekInfo | undefined> {
    const res = await client.request('GET', `${TRANSIT_MOUNT}/keys/${keyName}`);
    if (res.data === undefined) return undefined;
    const d = res.data;
    // A key that is exportable or of another type was not made by us: never adopt it.
    if (d.exportable === true || d.type !== KEK_KEY_TYPE) {
      throw new AppError('INTERNAL', `Transit key ${keyName} violates the KEK invariants`);
    }
    const latestVersion = Number(d.latest_version);
    const minDecryptionVersion = Number(d.min_decryption_version ?? 1);
    if (!Number.isInteger(latestVersion) || latestVersion < 1) {
      throw new AppError('INTERNAL', `Transit key ${keyName} returned no version`);
    }
    return { keyName, latestVersion, minDecryptionVersion: Math.max(1, minDecryptionVersion) };
  }

  async function requireKey(keyName: string): Promise<KekInfo> {
    const info = await readKey(keyName);
    if (info === undefined)
      throw new AppError('NOT_FOUND', `Transit key ${keyName} does not exist`);
    return info;
  }

  async function disabledState(tenantId: string): Promise<'disabled' | 'disabling' | undefined> {
    const res = await client.request('GET', statePath(tenantId));
    const inner = res.data?.data as { state?: unknown } | undefined;
    return inner?.state === 'disabled' || inner?.state === 'disabling' ? inner.state : undefined;
  }

  const putState = (tenantId: string, state: string, version: number) =>
    client.request('POST', statePath(tenantId), { data: { state, version } });

  async function refuseIfDisabled(tenantId: string): Promise<void> {
    if ((await disabledState(tenantId)) !== undefined) {
      throw new AppError('CONFLICT', `tenant KEK for ${tenantId} is disabled`);
    }
  }

  return {
    async ensureTenantKek(tenantId) {
      const keyName = kekKeyName(tenantId);
      try {
        return await traced(async () => {
          await refuseIfDisabled(tenantId);
          const existing = await readKey(keyName);
          if (existing !== undefined) {
            metrics.provision('exists');
            return { ...existing, created: false };
          }
          // exportable/backup flags are immutable after creation, so they are set here, once.
          await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}`, {
            type: KEK_KEY_TYPE,
            exportable: false,
            allow_plaintext_backup: false,
          });
          await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}/config`, {
            deletion_allowed: true,
          });
          const info = await requireKey(keyName);
          await audit({
            tenantId,
            action: 'secret.kek_provisioned',
            metadata: { keyName, version: info.latestVersion },
          });
          metrics.provision('created');
          return { ...info, created: true };
        });
      } catch (error) {
        metrics.provision('error');
        throw error;
      }
    },

    async rotateTenantKek(tenantId) {
      const keyName = kekKeyName(tenantId);
      try {
        return await traced(async () => {
          await refuseIfDisabled(tenantId);
          await requireKey(keyName);
          await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}/rotate`);
          const info = await requireKey(keyName);
          await audit({
            tenantId,
            action: 'secret.kek_rotated',
            metadata: { keyName, version: info.latestVersion },
          });
          metrics.rotate('ok');
          return info;
        });
      } catch (error) {
        metrics.rotate('error');
        throw error;
      }
    },

    async getKekMinVersion(tenantId) {
      const info = await traced(() => requireKey(kekKeyName(tenantId)));
      return info.minDecryptionVersion;
    },

    async setKekMinDecryptVersion(tenantId, version) {
      const keyName = kekKeyName(tenantId);
      return traced(async () => {
        await refuseIfDisabled(tenantId);
        const info = await requireKey(keyName);
        if (
          !Number.isInteger(version) ||
          version < info.minDecryptionVersion ||
          version > info.latestVersion
        ) {
          // Lowering would resurrect versions that may be trimmed; above latest is rejected by Transit.
          throw new AppError('VALIDATION_FAILED', 'min decrypt version out of range');
        }
        await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}/config`, {
          min_decryption_version: version,
        });
        return { ...info, minDecryptionVersion: version };
      });
    },

    async disableTenantKek(tenantId) {
      const keyName = kekKeyName(tenantId);
      return traced(async () => {
        const state = await disabledState(tenantId);
        const before = await requireKey(keyName);
        if (state === 'disabled') return before;
        // Marker first: from here on no caller may encrypt, so nothing lands in the new version.
        await putState(tenantId, 'disabling', before.latestVersion);
        await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}/rotate`);
        const rotated = await requireKey(keyName);
        await client.request('POST', `${TRANSIT_MOUNT}/keys/${keyName}/config`, {
          min_decryption_version: rotated.latestVersion,
        });
        await putState(tenantId, 'disabled', rotated.latestVersion);
        await audit({
          tenantId,
          action: 'secret.kek_disabled',
          metadata: { keyName, version: rotated.latestVersion },
        });
        return { ...rotated, minDecryptionVersion: rotated.latestVersion };
      });
    },

    isTenantKekDisabled(tenantId) {
      kekKeyName(tenantId);
      return traced(async () => (await disabledState(tenantId)) !== undefined);
    },
  };
}
