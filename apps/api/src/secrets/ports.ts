import type {
  AuditActor,
  AuditOutcome,
  AuditSeverity,
  AuditTarget,
  SecretBackend,
  SecretStatus,
  SecretType,
} from '@blackwing/contracts';
import type { Envelope } from '@blackwing/secrets';

/**
 * The ports the write-only secrets API composes (SECRETS-004). The Postgres adapter belongs to the tenant
 * data-access layer (`withTenant`, over the SECRETS-003 tables) and the audit ledger to AUDIT-002; the
 * service never reaches past these interfaces. Note what is absent: no port returns an envelope or a
 * value. The read side of this API cannot leak ciphertext because it is never handed any (§8.7).
 */

/** The authenticated caller. Authentication (token validity, revocation) happens before the handler. */
export interface SecretPrincipal {
  readonly type: 'user' | 'service';
  /** User id (or service-account id); recorded as the audit actor. */
  readonly id: string;
  /** The caller's tenant. Absent means no tenant context: the service fails closed. */
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  /** The API token used, when the caller is not on a console session. Recorded in audit only. */
  readonly tokenId?: string;
}

/** A secret without its value: the only shape the API layer ever holds. */
export interface SecretMetadata {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly type: SecretType | null;
  readonly purpose: string | null;
  readonly backend: SecretBackend;
  readonly status: SecretStatus;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An audit event before the ledger assigns its sequence number and hash (AUDIT-002). Never a value. */
export interface SecretAuditRecord {
  readonly action: 'secret.created' | 'secret.updated' | 'secret.deleted' | 'authz.denied';
  readonly severity: AuditSeverity;
  readonly outcome: AuditOutcome;
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly target: AuditTarget;
  readonly occurredAt: string;
  readonly traceId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** What `create` persists. The envelope is already encrypted; `idempotency` binds the request to the row. */
export interface NewSecret {
  readonly secret: SecretMetadata;
  readonly envelope: Envelope;
  /** `sha256(Idempotency-Key)` and the request fingerprint it was first used with. */
  readonly idempotency: { readonly keyHash: string; readonly fingerprint: string };
  /** Written in the same transaction as the secret (§8.8). */
  readonly audit: SecretAuditRecord;
}

export type CreateSecretResult =
  | { readonly kind: 'created'; readonly secret: SecretMetadata }
  | {
      readonly kind: 'idempotent_replay';
      readonly secret: SecretMetadata;
      readonly fingerprint: string;
    }
  | { readonly kind: 'name_conflict' };

/** A new version of a secret's value. `expectedVersion` is the `If-Match` version, when one was sent. */
export interface NewSecretVersion {
  readonly tenantId: string;
  readonly secretId: string;
  readonly envelope: Envelope;
  readonly expectedVersion?: number;
  readonly now: string;
  /** Built from the stored result so it can name the new version; written in the same transaction. */
  readonly audit: (after: SecretMetadata) => SecretAuditRecord;
}

export type AddVersionResult =
  | { readonly kind: 'updated'; readonly secret: SecretMetadata }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'stale' }
  /** The secret is not `active` (disabled, rotating or shredded), so its value cannot be replaced. */
  | { readonly kind: 'inactive'; readonly status: SecretStatus };

export interface DisableSecret {
  readonly tenantId: string;
  readonly secretId: string;
  readonly now: string;
  readonly audit: (after: SecretMetadata) => SecretAuditRecord;
}

export type DisableResult =
  | { readonly kind: 'disabled'; readonly secret: SecretMetadata }
  /** Already disabled or shredded: nothing changed, so nothing is audited. */
  | { readonly kind: 'unchanged'; readonly secret: SecretMetadata }
  | { readonly kind: 'not_found' };

/**
 * Secret persistence over `secrets` / `secret_versions`. Every method is tenant-scoped (RLS), and each
 * write is one transaction that includes its audit event. Writes are atomic: `create` binds the
 * idempotency key and the unique `(tenant_id, name)` in one critical section, `addVersion` bumps
 * `current_version` under a row lock and compares `expectedVersion`.
 */
export interface SecretStore {
  /** The secret a previous create with this key made, and that request's fingerprint. */
  findByIdempotencyKey(
    tenantId: string,
    keyHash: string,
  ): Promise<{ readonly secret: SecretMetadata; readonly fingerprint: string } | null>;
  create(input: NewSecret): Promise<CreateSecretResult>;
  get(tenantId: string, secretId: string): Promise<SecretMetadata | null>;
  /** Up to `limit` secrets ordered by id (UUIDv7: creation order), after `afterId` when given. */
  list(
    tenantId: string,
    page: { readonly afterId?: string; readonly limit: number },
  ): Promise<readonly SecretMetadata[]>;
  addVersion(input: NewSecretVersion): Promise<AddVersionResult>;
  disable(input: DisableSecret): Promise<DisableResult>;
}

/** Which kinds of resource still hold a `secret_ref` to a secret (connectors, asset credentials, ...). */
export interface SecretUsageReader {
  /** Distinct resource types, e.g. `['asset_credential']`; empty when nothing references the secret. */
  referencingTypes(tenantId: string, secretId: string): Promise<readonly string[]>;
}

/** Append-only audit writer for events that have no state change to ride with (denials). */
export interface SecretAuditSink {
  append(record: SecretAuditRecord): Promise<void>;
}
