import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { type SecretBackend, secretRefSchema } from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import {
  assertTenantId,
  type BackendTelemetry,
  type ExternalLocator,
  type ExternalStoreBackend,
  type KekWrapBackend,
  observe,
  parseBackendConfig,
} from './types.js';

/** Toggle that makes every call of a fake fail, like a sealed or unreachable customer store. */
export interface FakeControl {
  down: boolean;
}

export interface FakeBackendOptions {
  readonly kind?: SecretBackend;
  readonly telemetry?: BackendTelemetry;
}

const GCM_IV_BYTES = 12;
const GCM_PARTS = 3;
const kmsKeyFor = (tenantId: string): Buffer =>
  createHash('sha256').update(`fake-kms:${tenantId}`).digest();

/**
 * A `kek_wrap` stand-in for a customer KMS: really AES-256-GCM per tenant, so a wrapped DEK is opaque, bound to
 * its tenant and tamper-evident. The key derivation is fixed, which is fine for a test double only.
 */
export function createFakeKekWrapBackend(options: FakeBackendOptions = {}): {
  backend: KekWrapBackend;
  control: FakeControl;
} {
  const kind = options.kind ?? 'aws_kms';
  const telemetry = options.telemetry ?? {};
  const control: FakeControl = { down: false };
  const configSchema = z.object({ keyRef: secretRefSchema }).strict();
  const guard = (): void => {
    if (control.down) throw new AppError('KEK_UNAVAILABLE', 'fake KMS is down');
  };

  const backend: KekWrapBackend = {
    kind,
    mode: 'kek_wrap',
    configSchema,
    validate: (config) => {
      parseBackendConfig(configSchema, config);
    },
    health: () =>
      observe(telemetry, kind, 'health', () =>
        Promise.resolve(control.down ? { healthy: false } : { healthy: true }),
      ),
    testAccess: () =>
      observe(telemetry, kind, 'test_access', () => {
        guard();
        return Promise.resolve();
      }),
    async wrapDek(tenantId, dek) {
      assertTenantId(tenantId);
      return observe(telemetry, kind, 'wrap', () => {
        guard();
        const iv = randomBytes(GCM_IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', kmsKeyFor(tenantId), iv);
        const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
        const parts = [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url'));
        return Promise.resolve(`fake-kms:${tenantId}:${parts.join('.')}`);
      });
    },
    async unwrapDek(tenantId, wrapped) {
      assertTenantId(tenantId);
      return observe(telemetry, kind, 'unwrap', () => {
        guard();
        const [scheme, owner, body, ...extra] = wrapped.split(':');
        const parts = body?.split('.') ?? [];
        // Another tenant's wrapped DEK is refused by the tenant prefix before any decrypt is attempted.
        if (
          scheme !== 'fake-kms' ||
          owner !== tenantId ||
          parts.length !== GCM_PARTS ||
          extra.length > 0
        ) {
          throw new AppError('SECRET_DECRYPT_FAILED', 'wrapped DEK does not belong to this tenant');
        }
        const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            kmsKeyFor(tenantId),
            iv ?? Buffer.alloc(0),
          );
          decipher.setAuthTag(tag ?? Buffer.alloc(0));
          return Promise.resolve(
            new Uint8Array(
              Buffer.concat([decipher.update(ct ?? Buffer.alloc(0)), decipher.final()]),
            ),
          );
        } catch (cause) {
          throw new AppError('SECRET_DECRYPT_FAILED', 'wrapped DEK failed authentication', {
            cause,
          });
        }
      });
    },
  };
  return { backend, control };
}

/**
 * A `external_store` stand-in for a customer vault. Values are kept per tenant and a locator names its tenant,
 * so a locator from one tenant never reads another tenant's value.
 */
export function createFakeExternalStore(options: FakeBackendOptions = {}): {
  backend: ExternalStoreBackend;
  control: FakeControl;
  /** Read-only view of what the vault holds, for asserting where plaintext lives. */
  stored: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
} {
  const kind = options.kind ?? 'vault';
  const telemetry = options.telemetry ?? {};
  const control: FakeControl = { down: false };
  const vault = new Map<string, Map<string, Uint8Array>>();
  const configSchema = z.object({ address: z.url(), tokenRef: secretRefSchema }).strict();
  const REF = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  const guard = (): void => {
    if (control.down) throw new AppError('EXTERNAL_BACKEND_UNAVAILABLE', 'fake vault is down');
  };
  const bucket = (tenantId: string): Map<string, Uint8Array> => {
    const existing = vault.get(tenantId);
    if (existing !== undefined) return existing;
    const created = new Map<string, Uint8Array>();
    vault.set(tenantId, created);
    return created;
  };
  const ownLocator = (tenantId: string, locator: ExternalLocator): string => {
    if (locator.tenantId !== tenantId || typeof locator.ref !== 'string') {
      throw new AppError('SECRET_NOT_FOUND', 'no value at this locator');
    }
    return locator.ref;
  };

  const backend: ExternalStoreBackend = {
    kind,
    mode: 'external_store',
    configSchema,
    validate: (config) => {
      parseBackendConfig(configSchema, config);
    },
    health: () =>
      observe(telemetry, kind, 'health', () =>
        Promise.resolve(control.down ? { healthy: false } : { healthy: true }),
      ),
    testAccess: () =>
      observe(telemetry, kind, 'test_access', () => {
        guard();
        return Promise.resolve();
      }),
    async put(tenantId, ref, value) {
      assertTenantId(tenantId);
      return observe(telemetry, kind, 'put', () => {
        guard();
        if (!REF.test(ref)) throw new AppError('VALIDATION_FAILED', 'invalid store reference');
        const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
        bucket(tenantId).set(ref, new Uint8Array(bytes));
        return Promise.resolve({ provider: 'fake-vault', tenantId, ref });
      });
    },
    async get(tenantId, locator) {
      assertTenantId(tenantId);
      return observe(telemetry, kind, 'get', () => {
        guard();
        const value = bucket(tenantId).get(ownLocator(tenantId, locator));
        if (value === undefined) throw new AppError('SECRET_NOT_FOUND', 'no value at this locator');
        return Promise.resolve(new Uint8Array(value));
      });
    },
    async delete(tenantId, locator) {
      assertTenantId(tenantId);
      return observe(telemetry, kind, 'delete', () => {
        guard();
        bucket(tenantId).delete(ownLocator(tenantId, locator));
        return Promise.resolve();
      });
    },
  };
  return { backend, control, stored: vault };
}
