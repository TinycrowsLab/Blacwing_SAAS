import { trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  type CreateInputManifestUpload,
  INPUT_MANIFEST_CONTENT_TYPES,
  type InputManifestSpecObject,
  inputManifestSpecObjectSchema,
  type InputManifestUploadGrant,
  type InputManifestUploadKind,
  inputManifestUploadKindSchema,
  type InputManifestUploadStatus,
} from '@blackwing/contracts';
import { sha256Hex } from '@blackwing/crypto';
import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { type UploadProblemCode, uploadProblem } from './errors.js';
import { sanitiseFilename } from './filename.js';
import { permissionsOf } from '../assets/access.js';

import type { InputManifestUploadMetrics, UploadRejectReason } from './metrics.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { PresignedPostForm, StoredObjectHead, UploadObjectStore } from '@blackwing/evidence';
import type { Logger } from '@blackwing/logger';

/**
 * Input-manifest uploads (SCOPE-006, CONTEXT_PACK §4.5, §8.6, §8.8). A scoping user is granted a presigned POST policy
 * for one object; `complete` registers that object after reading its size, type and bytes from the store (never from
 * the client), and `DELETE` removes it while it is still pending scan. The permission is `assessment:create`.
 */

/** Who acts: a user of this tenant. `userId` is the user's row id (uuid). */
export interface UploadCaller {
  readonly tenantId: string;
  readonly userId: string;
}

/** The manifest row the service reads and writes. `specObjects` is validated against the contract before use. */
export interface StoredManifest {
  readonly id: string;
  readonly specObjects: readonly unknown[];
}

/**
 * Persistence the upload service composes. The Postgres adapter is `InputManifestRepository` in @blackwing/db: it runs in
 * the tenant's `withTenant` transaction, so another tenant's manifest reads as absent. Tests pass an in-memory double.
 */
export interface UploadManifestStore<Tx> {
  transact<R>(tenantId: string, fn: (tx: Tx) => Promise<R>): Promise<R>;
  rolesOf(tx: Tx, userId: string): Promise<readonly string[] | undefined>;
  lockById(tx: Tx, manifestId: string): Promise<StoredManifest | undefined>;
  setSpecObjects(
    tx: Tx,
    manifestId: string,
    specObjects: readonly InputManifestSpecObject[],
  ): Promise<void>;
}

/** Writes one audit event inside the transaction that changes the manifest (§8.8). */
export type UploadAudit<Tx> = (tx: Tx, event: AuditEventInput) => Promise<void>;

/** Limits of the upload path, from configuration (`SCOPE_*`). */
export interface UploadSettings {
  /** Largest accepted object, in bytes (`SCOPE_UPLOAD_MAX_BYTES`). */
  readonly maxBytes: number;
  /** Lifetime of a presigned grant, in seconds (`SCOPE_PRESIGN_TTL`). */
  readonly presignTtlSeconds: number;
  /** Most registered objects per manifest (`SCOPE_MANIFEST_MAX_OBJECTS`). */
  readonly maxObjectsPerManifest: number;
}

export interface InputManifestUploadDeps<Tx> {
  readonly store: UploadManifestStore<Tx>;
  readonly objects: UploadObjectStore;
  /** The bucket of input objects (Object Lock enabled in a deployment). */
  readonly bucket: string;
  readonly audit: UploadAudit<Tx>;
  readonly metrics: InputManifestUploadMetrics;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly settings: UploadSettings;
  readonly now?: () => Date;
  readonly newUploadId?: () => string;
}

/** The result of a granted upload: the grant the client posts, with its server-chosen key. */
export interface UploadGrantResult {
  readonly grant: InputManifestUploadGrant;
}

/** `complete` answers `201`-style registration with `created: true`, or the existing entry when it was a replay. */
export interface CompleteUploadResult {
  readonly created: boolean;
  readonly object: InputManifestSpecObject;
}

/** The media type of a `Content-Type` value: lower-cased, parameters (`; charset=…`) removed. */
function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0]?.trim().toLowerCase();
}

/** The per-upload key prefix: `inputs/{tenantId}/{manifestId}/{uploadId}-`, so a listing finds one upload's object. */
function uploadPrefix(tenantId: string, manifestId: string, uploadId: string): string {
  return `inputs/${tenantId}/${manifestId}/${uploadId}-`;
}

/** The object key: the tenant and manifest are server-side, the id is server-generated, the name is sanitised. */
function objectKeyOf(
  tenantId: string,
  manifestId: string,
  uploadId: string,
  filename: string,
): string {
  return `${uploadPrefix(tenantId, manifestId, uploadId)}${sanitiseFilename(filename)}`;
}

const MILLISECONDS_PER_SECOND = 1000;
/** Statuses from which an upload may still be removed. A scan that clears an object moves it out of this set. */
const REMOVABLE_STATUSES: readonly InputManifestUploadStatus[] = ['uploaded_pending_scan'];

const specObjectsSchema = z.array(inputManifestSpecObjectSchema);

/** The registered objects of a stored manifest. A malformed list is an internal fault: the service never guesses. */
function specObjectsOf(manifest: StoredManifest): InputManifestSpecObject[] {
  const parsed = specObjectsSchema.safeParse(manifest.specObjects);
  if (!parsed.success) throw new Error('input manifest spec_objects does not match its contract');
  return parsed.data;
}

/** Runs `fn` in a `api.scope.upload` span, so every upload operation is traced under one name. */
function inUploadSpan<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer('@blackwing/api').startActiveSpan('api.scope.upload', async (span) => {
    span.setAttribute('scope.operation', operation);
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

/** The wire code of each refusal reason (the reasons are counted as metrics; the codes are answered to the client). */
const REASON_CODE: Readonly<Record<UploadRejectReason, UploadProblemCode>> = {
  empty: 'scope_empty_upload',
  too_large: 'scope_upload_too_large',
  type_not_allowed: 'scope_upload_type_not_allowed',
  manifest_full: 'scope_manifest_full',
  object_missing: 'scope_object_missing',
  not_pending: 'scope_upload_not_pending',
};

/** The input-manifest upload service: request a grant, complete it after the upload, or delete it while pending. */
export class InputManifestUploadService<Tx> {
  private readonly now: () => Date;
  private readonly newUploadId: () => string;

  constructor(private readonly deps: InputManifestUploadDeps<Tx>) {
    this.now = deps.now ?? (() => new Date());
    this.newUploadId = deps.newUploadId ?? newId;
  }

  /** `POST /v1/input-manifests/:id/uploads`: validates the declaration and grants a presigned POST for one object. */
  async requestUpload(
    caller: UploadCaller,
    manifestId: string,
    body: CreateInputManifestUpload,
  ): Promise<UploadGrantResult> {
    return inUploadSpan('request', async () => {
      const uploadId = this.newUploadId();
      const objectKey = objectKeyOf(caller.tenantId, manifestId, uploadId, body.filename);
      const expiresAt = new Date(
        this.now().getTime() + this.deps.settings.presignTtlSeconds * MILLISECONDS_PER_SECOND,
      );
      const form = await this.deps.store.transact(caller.tenantId, async (tx) => {
        await this.assertCanUpload(tx, caller);
        const manifest = await this.requireManifest(tx, manifestId);
        if (body.sizeBytes === 0) throw this.reject('empty', 'the declared upload is empty');
        if (body.sizeBytes > this.deps.settings.maxBytes) {
          throw this.reject('too_large', 'the declared upload exceeds the size limit');
        }
        if (specObjectsOf(manifest).length >= this.deps.settings.maxObjectsPerManifest) {
          throw this.reject(
            'manifest_full',
            'the input manifest holds the maximum number of objects',
          );
        }
        const presigned = await this.presign(objectKey, body);
        await this.deps.audit(tx, {
          tenantId: caller.tenantId,
          action: 'scope.manifest.upload_requested',
          actor: { type: 'user', id: caller.userId },
          target: { type: 'input_manifest', id: manifestId },
          outcome: 'success',
          metadata: { kind: body.kind, uploadId, sizeBytes: body.sizeBytes },
        });
        return presigned;
      });
      this.deps.metrics.result(body.kind, 'requested');
      this.deps.logger.info(
        { tenantId: caller.tenantId, manifestId, uploadId, kind: body.kind },
        'scope.manifest.upload_requested',
      );
      return {
        grant: {
          uploadId,
          kind: body.kind,
          objectKey,
          method: 'POST',
          url: form.url,
          fields: { ...form.fields },
          expiresAt: expiresAt.toISOString(),
        },
      };
    });
  }

  /**
   * `POST …/uploads/:uploadId/complete`: registers the uploaded object. Size, type and digest come from the store. A
   * replay of a completed upload answers the existing entry; an object whose bytes match one already registered in this
   * manifest answers that entry and removes the new copy.
   */
  async completeUpload(
    caller: UploadCaller,
    manifestId: string,
    uploadId: string,
  ): Promise<CompleteUploadResult> {
    return inUploadSpan('complete', async () => {
      const registered = await this.deps.store.transact(caller.tenantId, async (tx) => {
        await this.assertCanUpload(tx, caller);
        const manifest = await this.requireManifest(tx, manifestId);
        return specObjectsOf(manifest).find((object) => object.uploadId === uploadId);
      });
      if (registered !== undefined) return { created: false, object: registered };

      const bucket = this.deps.bucket;
      const prefix = uploadPrefix(caller.tenantId, manifestId, uploadId);
      const [objectKey] = await this.deps.objects.listKeys(bucket, prefix, 2);
      const head =
        objectKey === undefined ? undefined : await this.deps.objects.head(bucket, objectKey);
      if (objectKey === undefined || head === undefined) {
        throw uploadProblem(
          'scope_object_missing',
          'no uploaded object is registered under this upload id',
        );
      }
      const kind = await this.checkStoredObject(objectKey, head);
      const contentType = mediaTypeOf(head.contentType) ?? '';
      const sizeBytes = head.contentLength ?? 0;
      const bytes = await this.deps.objects.getBytes(bucket, objectKey);
      if (bytes.byteLength !== sizeBytes) {
        throw uploadProblem(
          'scope_object_missing',
          'the uploaded object changed while it was read',
        );
      }
      const sha256 = sha256Hex(bytes);
      const outcome = await this.deps.store.transact(caller.tenantId, async (tx) => {
        await this.assertCanUpload(tx, caller);
        const manifest = await this.requireManifest(tx, manifestId);
        const objects = specObjectsOf(manifest);
        const same = objects.find((object) => object.uploadId === uploadId);
        if (same !== undefined) return { kind: 'existing' as const, object: same };
        const twin = objects.find((object) => object.sha256 === sha256);
        if (twin !== undefined) return { kind: 'duplicate' as const, object: twin };
        if (objects.length >= this.deps.settings.maxObjectsPerManifest) {
          return { kind: 'full' as const };
        }
        const entry: InputManifestSpecObject = {
          uploadId,
          kind,
          objectKey,
          sha256,
          sizeBytes,
          contentType,
          status: 'uploaded_pending_scan',
        };
        await this.deps.store.setSpecObjects(tx, manifestId, [...objects, entry]);
        await this.deps.audit(tx, {
          tenantId: caller.tenantId,
          action: 'scope.manifest.upload_completed',
          actor: { type: 'user', id: caller.userId },
          target: { type: 'input_manifest', id: manifestId },
          outcome: 'success',
          metadata: { objectKey, sha256, kind },
        });
        return { kind: 'registered' as const, object: entry };
      });
      if (outcome.kind === 'full') {
        await this.discard(bucket, objectKey);
        throw this.reject(
          'manifest_full',
          'the input manifest holds the maximum number of objects',
        );
      }
      if (outcome.kind === 'duplicate') {
        await this.discard(bucket, objectKey);
        this.deps.metrics.result(kind, 'duplicate');
        return { created: false, object: outcome.object };
      }
      if (outcome.kind === 'existing') return { created: false, object: outcome.object };
      this.deps.metrics.sizeBytes(kind, sizeBytes);
      this.deps.metrics.result(kind, 'completed');
      this.deps.logger.info(
        { tenantId: caller.tenantId, manifestId, uploadId, kind, sizeBytes },
        'scope.manifest.upload_completed',
      );
      return { created: true, object: outcome.object };
    });
  }

  /**
   * `DELETE …/uploads/:uploadId`: removes an upload that is still pending scan, whether or not it was registered yet.
   * A registered upload that a scan has since cleared is refused (`scope_upload_not_pending`).
   */
  async deleteUpload(caller: UploadCaller, manifestId: string, uploadId: string): Promise<void> {
    return inUploadSpan('delete', async () => {
      const registered = await this.deps.store.transact(caller.tenantId, async (tx) => {
        await this.assertCanUpload(tx, caller);
        const manifest = await this.requireManifest(tx, manifestId);
        const object = specObjectsOf(manifest).find((entry) => entry.uploadId === uploadId);
        if (object !== undefined && !REMOVABLE_STATUSES.includes(object.status)) {
          throw uploadProblem(
            'scope_upload_not_pending',
            'the upload has been scanned and can no longer be removed',
          );
        }
        return object;
      });
      const bucket = this.deps.bucket;
      const objectKey =
        registered?.objectKey ??
        (
          await this.deps.objects.listKeys(
            bucket,
            uploadPrefix(caller.tenantId, manifestId, uploadId),
            2,
          )
        )[0];
      if (objectKey === undefined) throw new NotFoundError('upload not found');
      await this.deps.objects.deleteObject(bucket, objectKey);
      await this.deps.store.transact(caller.tenantId, async (tx) => {
        await this.assertCanUpload(tx, caller);
        const manifest = await this.requireManifest(tx, manifestId);
        const objects = specObjectsOf(manifest);
        const remaining = objects.filter((entry) => entry.uploadId !== uploadId);
        if (remaining.length !== objects.length) {
          await this.deps.store.setSpecObjects(tx, manifestId, remaining);
        }
        await this.deps.audit(tx, {
          tenantId: caller.tenantId,
          action: 'scope.manifest.upload_deleted',
          actor: { type: 'user', id: caller.userId },
          target: { type: 'input_manifest', id: manifestId },
          outcome: 'success',
          metadata: { uploadId },
        });
      });
      if (registered !== undefined) this.deps.metrics.result(registered.kind, 'deleted');
      this.deps.logger.info(
        { tenantId: caller.tenantId, manifestId, uploadId },
        'scope.manifest.upload_deleted',
      );
    });
  }

  /** RBAC: the caller's roles must grant `assessment:create` in this tenant. Non-members and others are refused. */
  private async assertCanUpload(tx: Tx, caller: UploadCaller): Promise<void> {
    const roles = await this.deps.store.rolesOf(tx, caller.userId);
    if (roles === undefined) throw new ForbiddenError('not a member of this tenant');
    if (!permissionsOf(roles).includes('assessment:create')) {
      throw new ForbiddenError('the upload is not permitted for this caller');
    }
  }

  /** The manifest of this tenant, or `404`: another tenant's manifest is indistinguishable from a missing one. */
  private async requireManifest(tx: Tx, manifestId: string): Promise<StoredManifest> {
    const manifest = await this.deps.store.lockById(tx, manifestId);
    if (manifest === undefined) throw new NotFoundError('input manifest not found');
    return manifest;
  }

  /** The presigned POST: a `Content-Length` range up to the declared size and the exact type and kind bound by the policy. */
  private async presign(
    objectKey: string,
    body: CreateInputManifestUpload,
  ): Promise<PresignedPostForm> {
    return this.deps.objects.presignPost({
      bucket: this.deps.bucket,
      key: objectKey,
      maxBytes: body.sizeBytes,
      contentType: body.contentType,
      metadata: { 'x-amz-meta-kind': body.kind },
      expiresInSeconds: this.deps.settings.presignTtlSeconds,
    });
  }

  /**
   * Checks what the store reports for the object: its size, its type for its kind (the kind is the one the grant
   * bound into the policy). A refused object is removed and never registered. Returns the validated kind.
   */
  private async checkStoredObject(
    objectKey: string,
    head: StoredObjectHead,
  ): Promise<InputManifestUploadKind> {
    const parsedKind = inputManifestUploadKindSchema.safeParse(head.metadata.kind);
    const mediaType = mediaTypeOf(head.contentType) ?? '';
    const size = head.contentLength ?? 0;
    if (size === 0) {
      await this.discard(this.deps.bucket, objectKey);
      throw this.reject('empty', 'the uploaded object is empty');
    }
    if (size > this.deps.settings.maxBytes) {
      await this.discard(this.deps.bucket, objectKey);
      throw this.reject('too_large', 'the uploaded object exceeds the size limit');
    }
    if (!parsedKind.success || !INPUT_MANIFEST_CONTENT_TYPES[parsedKind.data].includes(mediaType)) {
      await this.discard(this.deps.bucket, objectKey);
      throw this.reject('type_not_allowed', 'the uploaded object type is not allowed for its kind');
    }
    return parsedKind.data;
  }

  /** Removes a refused or duplicate object. A failure is logged: the object is quarantined and never registered. */
  private async discard(bucket: string, objectKey: string): Promise<void> {
    try {
      await this.deps.objects.deleteObject(bucket, objectKey);
    } catch (error) {
      this.deps.logger.warn({ err: error }, 'scope.manifest.upload_discard_failed');
    }
  }

  /** Counts a refused upload by its closed reason and returns the matching problem. */
  private reject(reason: UploadRejectReason, detail: string) {
    this.deps.metrics.rejected(reason);
    const code = REASON_CODE[reason];
    return uploadProblem(code, detail);
  }
}
