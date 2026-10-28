import { AppError } from '@blackwing/errors';

import { type Envelope, type EnvelopeCrypto, EnvelopeError } from './envelope.js';

import type { KekInfo, TenantKekService } from './kek.js';
import type { SecretBackend, SecretStatus } from '@blackwing/contracts';

/**
 * Secret value rotation, tenant KEK rotation and the DEK rewrap (SECRETS-012, §8.6, §8.7, §8.8).
 *
 * A value rotation writes a new version and retires the prior one after a grace period, so consumers
 * pinned to `?v=old` keep resolving until it ends. A KEK rotation makes a new key version, re-wraps every
 * DEK of the tenant to it in batches and only then raises the minimum decrypt version: until the rewrap
 * completes, old ciphertext still decrypts, so an interrupted run is safe to resume. Data ciphertext is
 * never touched by a rewrap. Plaintext is handed to the envelope crypto and never logged or stored here.
 */

/** A secret record as rotation needs it: the current version and its envelope. */
export interface RotationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly purpose: string | null;
  readonly backend: SecretBackend;
  readonly status: SecretStatus;
  readonly currentVersion: number;
  readonly envelope: Envelope | null;
  readonly externalLocator: Readonly<Record<string, unknown>> | null;
}

/** One version as it is written into `secret_versions` when it is superseded. */
interface RotationVersionSlot {
  readonly version: number;
  readonly envelope: Envelope | null;
  readonly externalLocator: Readonly<Record<string, unknown>> | null;
}

/** The atomic change of a value rotation: the prior version retires, the next becomes current. */
export interface RotationCommit {
  readonly secretId: string;
  /** The version the rotation read; the commit fails when another rotation moved it on. */
  readonly expectedVersion: number;
  readonly previous: RotationVersionSlot & { readonly retiredAt: Date };
  readonly next: { readonly version: number; readonly envelope: Envelope };
}

/** A DEK envelope still wrapped under an older KEK version. `source` tells which table it lives in. */
export interface RewrapCandidate {
  readonly source: 'current' | 'version';
  readonly secretId: string;
  readonly version: number;
  readonly envelope: Envelope;
}

/** Keyset position of a rewrap pass: the last candidate handled. */
export interface RewrapCursor {
  readonly secretId: string;
  readonly version: number;
  readonly source: RewrapCandidate['source'];
}

/** Tenant-scoped persistence for rotation. Every call runs inside the tenant's RLS context. */
export interface RotationStore {
  /** The secret's current state, or `null` for an unknown secret (or another tenant's). */
  loadForRotation(tenantId: string, secretId: string): Promise<RotationRecord | null>;
  /** `false` when `expectedVersion` is no longer current: nothing was written. */
  commitRotation(tenantId: string, commit: RotationCommit): Promise<boolean>;
  /**
   * Up to `limit` DEK envelopes of `kekKey` below `beforeVersion`, in `(secretId, version, source)` order
   * after `after`. Only `openbao`-backed secrets qualify: external-store secrets have no DEK to rewrap.
   */
  nextRewrapBatch(
    tenantId: string,
    kekKey: string,
    beforeVersion: number,
    after: RewrapCursor | undefined,
    limit: number,
  ): Promise<RewrapCandidate[]>;
  /** `false` when the row changed under the pass (its version moved on): the stale write is dropped. */
  saveRewrap(tenantId: string, candidate: RewrapCandidate, envelope: Envelope): Promise<boolean>;
}

export interface SecretRotationAuditEvent {
  readonly tenantId: string;
  readonly action: 'secret.rotated' | 'secret.rewrapped';
  /** Ids, version numbers and counts only; never a value or a wrapped key. */
  readonly metadata: Readonly<Record<string, string | number>>;
}

export interface RotationMetrics {
  /** `secret_rotations_total{result}` */
  rotation(result: 'ok' | 'error'): void;
  /** `kek_rotations_total{result}` */
  kekRotation(result: 'ok' | 'error'): void;
  /** `secret_rewrap_total`: one per envelope re-wrapped. */
  rewrapped(): void;
  /** `secret_rewrap_errors_total`: one per failed re-wrap, which aborts the pass (resumable). */
  rewrapError(): void;
}

export interface SecretRotationDeps {
  readonly store: RotationStore;
  readonly crypto: Pick<EnvelopeCrypto, 'encryptSecret' | 'rewrap'>;
  readonly kek: Pick<
    TenantKekService,
    'rotateTenantKek' | 'getTenantKek' | 'setKekMinDecryptVersion' | 'isTenantKekDisabled'
  >;
  /** Required: a rotation or rewrap that cannot be audited is not reported as done. */
  readonly audit: (event: SecretRotationAuditEvent) => Promise<void>;
  /** `SECRET_VERSION_GRACE_MS`: how long a superseded version keeps resolving. */
  readonly graceMs: number;
  /** Envelopes per rewrap batch (default 100). */
  readonly rewrapBatchSize?: number;
  readonly metrics?: RotationMetrics;
  readonly span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

export interface RotateSecretInput {
  readonly tenantId: string;
  readonly secretId: string;
  readonly plaintext: string;
}

export interface RotateSecretResult {
  readonly version: number;
  readonly previousVersion: number;
  /** When the previous version stops resolving. */
  readonly retiredAt: Date;
}

export interface KekRotationResult extends KekInfo {
  /** Envelopes re-wrapped by this pass. */
  readonly rewrapped: number;
}

export interface SecretRotationService {
  rotateSecret(input: RotateSecretInput): Promise<RotateSecretResult>;
  /**
   * Makes a new KEK version, re-wraps the tenant to it, then raises the minimum decrypt version. A failure
   * at any step leaves every ciphertext decryptable; call {@link rewrapTenantKek} to resume.
   */
  rotateTenantKek(tenantId: string): Promise<KekRotationResult>;
  /** Re-wraps the tenant to its newest KEK version and raises the minimum. Idempotent and resumable. */
  rewrapTenantKek(tenantId: string): Promise<KekRotationResult>;
}

const DEFAULT_REWRAP_BATCH = 100;
const noSpan = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

export function createSecretRotation(deps: SecretRotationDeps): SecretRotationService {
  const { store, crypto, kek, audit } = deps;
  const metrics = deps.metrics;
  const span = deps.span ?? noSpan;
  const now = deps.now ?? Date.now;
  const batchSize = deps.rewrapBatchSize ?? DEFAULT_REWRAP_BATCH;

  function kekKeyOf(tenantId: string): string {
    return `tenant-${tenantId.toLowerCase()}`;
  }

  async function rotateValue(input: RotateSecretInput): Promise<RotateSecretResult> {
    const { tenantId, secretId, plaintext } = input;
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'the new secret value must be a non-empty string');
    }
    if (await kek.isTenantKekDisabled(tenantId)) {
      throw new EnvelopeError('KEK_DISABLED', 'tenant key is disabled; secrets cannot be rotated');
    }
    const record = await store.loadForRotation(tenantId, secretId);
    if (record === null) throw new AppError('SECRET_NOT_FOUND', 'secret not found');
    if (record.status === 'shredded') throw new AppError('SECRET_SHREDDED', 'secret was shredded');
    if (record.status === 'disabled') throw new AppError('SECRET_DISABLED', 'secret is disabled');
    // Customer-owned stores need their own writer (SECRETS-009..011). Until one is wired, refuse loudly.
    if (record.backend !== 'openbao') {
      throw new AppError(
        'EXTERNAL_BACKEND_UNAVAILABLE',
        'rotating a customer-owned secret needs its external store adapter',
      );
    }
    if (record.envelope === null || record.purpose === null) {
      throw new EnvelopeError('ENVELOPE_INVALID', 'secret has no envelope or purpose to bind');
    }

    const previousVersion = record.currentVersion;
    const version = previousVersion + 1;
    const retiredAt = new Date(now() + deps.graceMs);
    const envelope = await crypto.encryptSecret({
      tenantId,
      plaintext,
      context: { secretId, purpose: record.purpose },
    });
    const committed = await store.commitRotation(tenantId, {
      secretId,
      expectedVersion: previousVersion,
      previous: {
        version: previousVersion,
        envelope: record.envelope,
        externalLocator: record.externalLocator,
        retiredAt,
      },
      next: { version, envelope },
    });
    if (!committed) {
      throw new AppError('CONFLICT', 'secret was rotated concurrently; retry the rotation');
    }
    await audit({
      tenantId,
      action: 'secret.rotated',
      metadata: { secretId, version, previousVersion },
    });
    return { version, previousVersion, retiredAt };
  }

  /** Re-wraps every envelope below `targetVersion`, batch by batch. Returns how many were re-wrapped. */
  async function rewrapAll(tenantId: string, targetVersion: number): Promise<number> {
    const kekKey = kekKeyOf(tenantId);
    let cursor: RewrapCursor | undefined;
    let rewrapped = 0;
    for (;;) {
      const batch = await store.nextRewrapBatch(tenantId, kekKey, targetVersion, cursor, batchSize);
      if (batch.length === 0) return rewrapped;
      for (const candidate of batch) {
        try {
          const envelope = await crypto.rewrap(candidate.envelope, { tenantId });
          if (await store.saveRewrap(tenantId, candidate, envelope)) {
            rewrapped += 1;
            metrics?.rewrapped();
          }
        } catch (error) {
          metrics?.rewrapError();
          throw error;
        }
      }
      const last = batch[batch.length - 1];
      if (last === undefined) return rewrapped;
      cursor = { secretId: last.secretId, version: last.version, source: last.source };
    }
  }

  async function rewrapTenantKekInner(tenantId: string): Promise<KekRotationResult> {
    if (await kek.isTenantKekDisabled(tenantId)) {
      throw new EnvelopeError('KEK_DISABLED', 'tenant key is disabled; nothing can be re-wrapped');
    }
    const info = await kek.getTenantKek(tenantId);
    const rewrapped = await rewrapAll(tenantId, info.latestVersion);
    // Only now: raising the floor earlier would make the not-yet-rewrapped ciphertext unreadable.
    const minimum = await kek.setKekMinDecryptVersion(tenantId, info.latestVersion);
    await audit({
      tenantId,
      action: 'secret.rewrapped',
      metadata: { keyName: info.keyName, version: info.latestVersion, count: rewrapped },
    });
    return { ...minimum, rewrapped };
  }

  return {
    rotateSecret: (input) =>
      span('secret.rotate', async () => {
        try {
          const result = await rotateValue(input);
          metrics?.rotation('ok');
          return result;
        } catch (error) {
          metrics?.rotation('error');
          throw error;
        }
      }),

    rotateTenantKek: (tenantId) =>
      span('secret.rotate', async () => {
        try {
          await kek.rotateTenantKek(tenantId);
        } catch (error) {
          metrics?.kekRotation('error');
          throw error;
        }
        try {
          const result = await rewrapTenantKekInner(tenantId);
          metrics?.kekRotation('ok');
          return result;
        } catch (error) {
          metrics?.kekRotation('error');
          throw error;
        }
      }),

    rewrapTenantKek: (tenantId) => span('secret.rotate', () => rewrapTenantKekInner(tenantId)),
  };
}
