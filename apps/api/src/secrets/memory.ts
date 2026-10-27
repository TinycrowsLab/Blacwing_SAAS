import type {
  AddVersionResult,
  CreateSecretResult,
  DisableResult,
  DisableSecret,
  NewSecret,
  NewSecretVersion,
  SecretAuditRecord,
  SecretAuditSink,
  SecretMetadata,
  SecretStore,
  SecretUsageReader,
} from './ports.js';
import type { Envelope } from '@blackwing/secrets';

/** Collects audit records in memory (tests; AUDIT-002 provides the ledger writer). */
export class InMemorySecretAuditSink implements SecretAuditSink {
  readonly records: SecretAuditRecord[] = [];

  append(record: SecretAuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

interface Entry {
  secret: SecretMetadata;
  readonly versions: Map<number, Envelope>;
}

/**
 * In-process `SecretStore` for unit tests and the API's local dev wiring until the Postgres adapter
 * lands with the tenant data-access layer (#95). Every method contains no `await`, so on one event loop
 * each is a single critical section, the guarantee the DB adapter gets from the unique indexes and a row
 * lock. Reads are filtered by tenant, like RLS, and a write appends its audit record with the state change.
 */
export class InMemorySecretStore implements SecretStore {
  private readonly entries = new Map<string, Entry>();
  private readonly keys = new Map<string, { readonly id: string; readonly fingerprint: string }>();

  constructor(private readonly audit: InMemorySecretAuditSink = new InMemorySecretAuditSink()) {}

  findByIdempotencyKey(
    tenantId: string,
    keyHash: string,
  ): Promise<{ readonly secret: SecretMetadata; readonly fingerprint: string } | null> {
    return Promise.resolve(this.lookupKey(tenantId, keyHash));
  }

  create(input: NewSecret): Promise<CreateSecretResult> {
    const { secret, idempotency } = input;
    const bound = this.lookupKey(secret.tenantId, idempotency.keyHash);
    if (bound !== null) return Promise.resolve({ kind: 'idempotent_replay', ...bound });
    const taken = [...this.entries.values()].some(
      (e) => e.secret.tenantId === secret.tenantId && e.secret.name === secret.name,
    );
    if (taken) return Promise.resolve({ kind: 'name_conflict' });
    this.entries.set(secret.id, { secret, versions: new Map([[1, input.envelope]]) });
    this.keys.set(`${secret.tenantId}|${idempotency.keyHash}`, {
      id: secret.id,
      fingerprint: idempotency.fingerprint,
    });
    this.audit.records.push(input.audit);
    return Promise.resolve({ kind: 'created', secret });
  }

  get(tenantId: string, secretId: string): Promise<SecretMetadata | null> {
    return Promise.resolve(this.entryOf(tenantId, secretId)?.secret ?? null);
  }

  list(
    tenantId: string,
    page: { readonly afterId?: string; readonly limit: number },
  ): Promise<readonly SecretMetadata[]> {
    const after = page.afterId;
    return Promise.resolve(
      [...this.entries.values()]
        .map((e) => e.secret)
        .filter((s) => s.tenantId === tenantId && (after === undefined || s.id > after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, page.limit),
    );
  }

  addVersion(input: NewSecretVersion): Promise<AddVersionResult> {
    const entry = this.entryOf(input.tenantId, input.secretId);
    if (entry === undefined) return Promise.resolve({ kind: 'not_found' });
    if (entry.secret.status !== 'active') {
      return Promise.resolve({ kind: 'inactive', status: entry.secret.status });
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== entry.secret.currentVersion
    ) {
      return Promise.resolve({ kind: 'stale' });
    }
    const version = entry.secret.currentVersion + 1;
    entry.versions.set(version, input.envelope);
    entry.secret = { ...entry.secret, currentVersion: version, updatedAt: input.now };
    this.audit.records.push(input.audit(entry.secret));
    return Promise.resolve({ kind: 'updated', secret: entry.secret });
  }

  disable(input: DisableSecret): Promise<DisableResult> {
    const entry = this.entryOf(input.tenantId, input.secretId);
    if (entry === undefined) return Promise.resolve({ kind: 'not_found' });
    if (entry.secret.status === 'disabled' || entry.secret.status === 'shredded') {
      return Promise.resolve({ kind: 'unchanged', secret: entry.secret });
    }
    entry.secret = { ...entry.secret, status: 'disabled', updatedAt: input.now };
    this.audit.records.push(input.audit(entry.secret));
    return Promise.resolve({ kind: 'disabled', secret: entry.secret });
  }

  /** Test helper: the stored envelope of a version (what SECRETS-006's resolver would read). */
  envelopeOf(tenantId: string, secretId: string, version: number): Envelope | undefined {
    return this.entryOf(tenantId, secretId)?.versions.get(version);
  }

  /** Test helper: how many secrets and versions are persisted for a tenant. */
  count(tenantId: string): { readonly secrets: number; readonly versions: number } {
    const own = [...this.entries.values()].filter((e) => e.secret.tenantId === tenantId);
    return { secrets: own.length, versions: own.reduce((n, e) => n + e.versions.size, 0) };
  }

  private entryOf(tenantId: string, secretId: string): Entry | undefined {
    const entry = this.entries.get(secretId);
    return entry?.secret.tenantId === tenantId ? entry : undefined;
  }

  private lookupKey(
    tenantId: string,
    keyHash: string,
  ): { readonly secret: SecretMetadata; readonly fingerprint: string } | null {
    const bound = this.keys.get(`${tenantId}|${keyHash}`);
    const entry = bound === undefined ? undefined : this.entryOf(tenantId, bound.id);
    return bound === undefined || entry === undefined
      ? null
      : { secret: entry.secret, fingerprint: bound.fingerprint };
  }
}

/** A tenant-filtered `SecretUsageReader` over fixed references (tests and local dev wiring). */
export function createInMemorySecretUsage(
  references: readonly { tenantId: string; secretId: string; resourceType: string }[],
): SecretUsageReader {
  return {
    referencingTypes: (tenantId, secretId) =>
      Promise.resolve([
        ...new Set(
          references
            .filter((r) => r.tenantId === tenantId && r.secretId === secretId)
            .map((r) => r.resourceType),
        ),
      ]),
  };
}
