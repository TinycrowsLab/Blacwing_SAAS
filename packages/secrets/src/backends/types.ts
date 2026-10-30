import { AppError } from '@blackwing/errors';

import { TENANT_ID } from '../kek.js';

import type { SecretBackend } from '@blackwing/contracts';
import type { ZodType } from 'zod';

/**
 * How a backend holds key material (issue #112, §8.6, §8.7). The two modes have different data-residency
 * meaning and must never be conflated:
 * - `kek_wrap` (BYOK): the backend only wraps and unwraps a DEK. Ciphertext stays in Blackwing's database.
 * - `external_store` (BYO-vault): the plaintext lives in the customer's store. Blackwing keeps only the locator.
 */
export type SecretBackendMode = 'kek_wrap' | 'external_store';

/** Opaque pointer into a customer store, persisted as `external_locator`. Must never hold plaintext. */
export type ExternalLocator = Readonly<Record<string, unknown>>;

export interface BackendHealth {
  readonly healthy: boolean;
  /** Operator-facing reason. Never logged or returned to tenants with secret material in it. */
  readonly reason?: string;
}

export type BackendOp =
  'wrap' | 'unwrap' | 'put' | 'get' | 'delete' | 'validate' | 'test_access' | 'health';

/** `secret_backend_calls_total{kind,op,result}` */
export interface SecretBackendMetrics {
  record(kind: SecretBackend, op: BackendOp, result: 'ok' | 'error'): void;
}

/** Wraps each backend call in the `secret.backend` trace span. */
export type BackendSpan = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface BackendTelemetry {
  readonly metrics?: SecretBackendMetrics;
  readonly span?: BackendSpan;
}

interface SecretBackendBase {
  readonly kind: SecretBackend;
  readonly mode: SecretBackendMode;
  /** Config schema for this backend type. Credentials inside it are `secret_ref`s, never plaintext. */
  readonly configSchema: ZodType;
  /** Throws `VALIDATION_FAILED` naming each invalid field (never its value). */
  validate(config: unknown): void;
  /** Probes the bound backend. Throws, with the reason, when it cannot be reached or refuses access. */
  testAccess(): Promise<void>;
  /** Never throws: an unreachable backend reports `healthy: false`. */
  health(): Promise<BackendHealth>;
}

/** BYOK: wraps and unwraps DEKs; data ciphertext never leaves Blackwing. */
export interface KekWrapBackend extends SecretBackendBase {
  readonly mode: 'kek_wrap';
  wrapDek(tenantId: string, dek: Uint8Array): Promise<string>;
  unwrapDek(tenantId: string, wrapped: string): Promise<Uint8Array>;
}

/** BYO-vault: plaintext is stored in, read from and deleted from the customer's store. */
export interface ExternalStoreBackend extends SecretBackendBase {
  readonly mode: 'external_store';
  put(tenantId: string, ref: string, value: Uint8Array | string): Promise<ExternalLocator>;
  get(tenantId: string, locator: ExternalLocator): Promise<Uint8Array | string>;
  delete(tenantId: string, locator: ExternalLocator): Promise<void>;
}

export type SecretBackendImpl = KekWrapBackend | ExternalStoreBackend;

const defaultSpan: BackendSpan = (_name, fn) => fn();

/** Runs one backend operation under its metric and span. The error is rethrown unchanged. */
export function observe<T>(
  telemetry: BackendTelemetry,
  kind: SecretBackend,
  op: BackendOp,
  fn: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    try {
      const out = await fn();
      telemetry.metrics?.record(kind, op, 'ok');
      return out;
    } catch (error) {
      telemetry.metrics?.record(kind, op, 'error');
      throw error;
    }
  };
  return (telemetry.span ?? defaultSpan)('secret.backend', run);
}

/** Tenant ids reach a key name or a store path, so only the conservative alphabet passes. */
export function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
    throw new AppError('VALIDATION_FAILED', 'invalid tenant id for a secret backend');
  }
}

/** Shared `validate` body: a Zod failure becomes `VALIDATION_FAILED` with field paths only. */
export function parseBackendConfig(schema: ZodType, config: unknown): void {
  const result = schema.safeParse(config);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new AppError(
      'VALIDATION_FAILED',
      `invalid secret backend config: ${[...new Set(fields)].join(', ')}`,
    );
  }
}
