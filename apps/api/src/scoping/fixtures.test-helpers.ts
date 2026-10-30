import type { StoredManifest, UploadManifestStore } from './service.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { InputManifestSpecObject } from '@blackwing/contracts';
import type {
  PresignedPostForm,
  PresignPostPolicy,
  StoredObjectHead,
  UploadObjectStore,
} from '@blackwing/evidence';

export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
export const ADMIN_A = '0198f0a0-0000-7000-8000-0000000000a1';
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
export const ADMIN_B = '0198f0a0-0000-7000-8000-0000000000b1';
export const MANIFEST_A = '0198f0a0-0000-7000-8000-0000000000c1';
export const MANIFEST_B = '0198f0a0-0000-7000-8000-0000000000c2';
export const BUCKET = 'bw-inputs-test';
export const NOW = new Date('2026-10-30T10:00:00.000Z');

/** A transaction of the in-memory double: the tenant it runs for. */
export interface MemoryTx {
  readonly tenantId: string;
}

/** An object as the store holds it: the bytes and the metadata the client sent with them (keys without `x-amz-meta-`). */
interface MemoryObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly metadata: Record<string, string>;
}

/** The manifest and membership tables of the double, keyed by tenant. */
export interface MemoryTables {
  readonly manifests: Record<string, Record<string, InputManifestSpecObject[]>>;
  readonly memberships: Record<string, Record<string, readonly string[]>>;
}

/** The manifest store double. Like the Postgres adapter, it only sees the manifests of the transaction's tenant. */
export function memoryManifestStore(tables: MemoryTables): UploadManifestStore<MemoryTx> {
  return {
    transact: (tenantId, fn) => fn({ tenantId }),
    rolesOf: (tx, userId) => Promise.resolve(tables.memberships[tx.tenantId]?.[userId]),
    lockById: (tx, manifestId) => {
      const specObjects = tables.manifests[tx.tenantId]?.[manifestId];
      const manifest: StoredManifest | undefined =
        specObjects === undefined ? undefined : { id: manifestId, specObjects };
      return Promise.resolve(manifest);
    },
    setSpecObjects: (tx, manifestId, specObjects) => {
      const byManifest = tables.manifests[tx.tenantId];
      if (byManifest?.[manifestId] !== undefined) byManifest[manifestId] = [...specObjects];
      return Promise.resolve();
    },
  };
}

/** The object store double: records presign policies and deletions, and holds the uploaded objects in memory. */
export interface MemoryObjectStore extends UploadObjectStore {
  readonly objects: Map<string, MemoryObject>;
  readonly policies: PresignPostPolicy[];
  readonly deleted: string[];
  /** Stands in for the client's upload: the object appears under `key`, as the store reports it. */
  put(key: string, object: MemoryObject): void;
}

export function memoryObjectStore(): MemoryObjectStore {
  const objects = new Map<string, MemoryObject>();
  const policies: PresignPostPolicy[] = [];
  const deleted: string[] = [];
  return {
    objects,
    policies,
    deleted,
    put: (key, object) => {
      objects.set(key, object);
    },
    presignPost: (policy) => {
      policies.push(policy);
      const form: PresignedPostForm = {
        url: `https://store.test/${policy.bucket}`,
        fields: { key: policy.key, 'Content-Type': policy.contentType, ...policy.metadata },
      };
      return Promise.resolve(form);
    },
    head: (_bucket, key) => {
      const object = objects.get(key);
      const head: StoredObjectHead | undefined =
        object === undefined
          ? undefined
          : {
              contentType: object.contentType,
              contentLength: object.bytes.byteLength,
              metadata: object.metadata,
            };
      return Promise.resolve(head);
    },
    listKeys: (_bucket, prefix, limit) =>
      Promise.resolve([...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit)),
    getBytes: (_bucket, key) => {
      const object = objects.get(key);
      if (object === undefined) return Promise.reject(new Error('no such object'));
      return Promise.resolve(object.bytes);
    },
    deleteObject: (_bucket, key) => {
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
  };
}

/** The audit events the double received, in order. */
export function memoryAudit(): {
  readonly events: AuditEventInput[];
  /** Accepts any transaction: the audit double does not read the transaction, only records the event. */
  readonly write: (tx: unknown, event: AuditEventInput) => Promise<void>;
} {
  const events: AuditEventInput[] = [];
  return {
    events,
    write: (_tx, event) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/** A small, valid OpenAPI document as bytes. */
export const SPEC_BYTES = new TextEncoder().encode('{"openapi":"3.1.0"}');

/** Tables with one manifest per tenant, an admin in tenant A and an auditor (no `assessment:create`) in tenant A. */
export function tablesFor(): MemoryTables {
  return {
    manifests: { [TENANT_A]: { [MANIFEST_A]: [] }, [TENANT_B]: { [MANIFEST_B]: [] } },
    memberships: {
      [TENANT_A]: { [ADMIN_A]: ['org_admin'], [AUDITOR_A]: ['auditor'] },
      [TENANT_B]: { [ADMIN_B]: ['org_admin'] },
    },
  };
}
