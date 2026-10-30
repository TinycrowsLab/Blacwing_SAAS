import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256Hex } from '@blackwing/crypto';
import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import {
  ADMIN_A,
  ADMIN_B,
  AUDITOR_A,
  BUCKET,
  MANIFEST_A,
  MANIFEST_B,
  memoryAudit,
  memoryManifestStore,
  memoryObjectStore,
  NOW,
  SPEC_BYTES,
  TENANT_A,
  TENANT_B,
  tablesFor,
  type MemoryTables,
  type MemoryTx,
} from './fixtures.test-helpers.js';
import { InputManifestUploadService, type UploadSettings } from './service.js';

import type { InputManifestUploadMetrics, UploadRejectReason, UploadResult } from './metrics.js';
import type {
  CreateInputManifestUpload,
  InputManifestSpecObject,
  InputManifestUploadKind,
} from '@blackwing/contracts';

const UPLOAD_1 = '0198f0a0-0000-7000-8000-000000000101';
const UPLOAD_2 = '0198f0a0-0000-7000-8000-000000000102';
const UPLOAD_3 = '0198f0a0-0000-7000-8000-000000000103';
const SETTINGS: UploadSettings = {
  maxBytes: 1000,
  presignTtlSeconds: 300,
  maxObjectsPerManifest: 2,
};
const logger = createLogger('api', { level: 'silent', nodeEnv: 'test' });

function recordingMetrics() {
  const results: { kind: InputManifestUploadKind; result: UploadResult }[] = [];
  const rejected: UploadRejectReason[] = [];
  const metrics: InputManifestUploadMetrics = {
    result: (kind, result) => {
      results.push({ kind, result });
    },
    sizeBytes: () => undefined,
    rejected: (reason) => {
      rejected.push(reason);
    },
  };
  return { metrics, results, rejected };
}

/** A service over the in-memory doubles, with predictable upload ids. */
function build(options: { settings?: Partial<UploadSettings> } = {}) {
  const tables = tablesFor();
  const objects = memoryObjectStore();
  const audit = memoryAudit();
  const recorded = recordingMetrics();
  const uploadIds = [UPLOAD_1, UPLOAD_2, UPLOAD_3];
  const service = new InputManifestUploadService<MemoryTx>({
    store: memoryManifestStore(tables),
    objects,
    bucket: BUCKET,
    audit: audit.write,
    metrics: recorded.metrics,
    logger,
    settings: { ...SETTINGS, ...options.settings },
    now: () => NOW,
    newUploadId: () => uploadIds.shift() ?? '0198f0a0-0000-7000-8000-0000000001ff',
  });
  return { service, tables, objects, audit, ...recorded };
}

const caller = (userId: string, tenantId = TENANT_A) => ({ tenantId, userId });

/** The manifest table of one tenant. The fixtures always seed the tenants the tests name. */
function manifestsOf(
  tables: MemoryTables,
  tenantId: string,
): Record<string, InputManifestSpecObject[]> {
  const manifests = tables.manifests[tenantId];
  if (manifests === undefined) throw new Error(`no manifests seeded for ${tenantId}`);
  return manifests;
}
const declaration = (
  overrides: Partial<CreateInputManifestUpload> = {},
): CreateInputManifestUpload => ({
  kind: 'openapi',
  filename: 'api.json',
  contentType: 'application/json',
  sizeBytes: 10,
  ...overrides,
});

/** The key the grant names for an upload of tenant A's manifest A. */
const keyFor = (uploadId: string, name: string, tenantId = TENANT_A, manifestId = MANIFEST_A) =>
  `inputs/${tenantId}/${manifestId}/${uploadId}-${name}`;

/** Stands in for the client's upload of the bytes the grant named. */
function uploadedAs(bytes: Uint8Array, contentType: string | undefined, kind: string | undefined) {
  return {
    bytes,
    contentType,
    metadata: kind === undefined ? {} : { kind },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InputManifestUploadService.requestUpload (SCOPE-006)', () => {
  it('grants a presigned POST bound to the declared size, type and kind, under a server key', async () => {
    const { service, objects, audit, results } = build();
    const { grant } = await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    expect(grant).toMatchObject({
      uploadId: UPLOAD_1,
      kind: 'openapi',
      objectKey: keyFor(UPLOAD_1, 'api.json'),
      method: 'POST',
      expiresAt: '2026-10-30T10:05:00.000Z',
    });
    expect(objects.policies).toEqual([
      {
        bucket: BUCKET,
        key: keyFor(UPLOAD_1, 'api.json'),
        maxBytes: 10,
        contentType: 'application/json',
        metadata: { 'x-amz-meta-kind': 'openapi' },
        expiresInSeconds: 300,
      },
    ]);
    expect(audit.events).toEqual([
      expect.objectContaining({
        tenantId: TENANT_A,
        action: 'scope.manifest.upload_requested',
        actor: { type: 'user', id: ADMIN_A },
        target: { type: 'input_manifest', id: MANIFEST_A },
        metadata: { kind: 'openapi', uploadId: UPLOAD_1, sizeBytes: 10 },
      }),
    ]);
    expect(results).toEqual([{ kind: 'openapi', result: 'requested' }]);
  });

  it('sanitises the filename into the key and never lets a path escape the tenant prefix', async () => {
    const { service, objects } = build();
    const { grant } = await service.requestUpload(
      caller(ADMIN_A),
      MANIFEST_A,
      declaration({ filename: '../../other-tenant/secret.json' }),
    );
    expect(grant.objectKey).toBe(keyFor(UPLOAD_1, 'other-tenant_secret.json'));
    expect(objects.policies[0]?.key.startsWith(`inputs/${TENANT_A}/${MANIFEST_A}/`)).toBe(true);
  });

  it('refuses an empty declaration with scope_empty_upload and grants nothing', async () => {
    const { service, objects, audit, rejected } = build();
    await expect(
      service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration({ sizeBytes: 0 })),
    ).rejects.toMatchObject({ problemCode: 'scope_empty_upload' });
    expect(objects.policies).toEqual([]);
    expect(audit.events).toEqual([]);
    expect(rejected).toEqual(['empty']);
  });

  it('refuses a declaration over the size limit with scope_upload_too_large', async () => {
    const { service, objects, rejected } = build();
    await expect(
      service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration({ sizeBytes: 1001 })),
    ).rejects.toMatchObject({ problemCode: 'scope_upload_too_large' });
    expect(objects.policies).toEqual([]);
    expect(rejected).toEqual(['too_large']);
  });

  it('refuses a member without assessment:create (RBAC) before anything is granted', async () => {
    const { service, objects } = build();
    await expect(
      service.requestUpload(caller(AUDITOR_A), MANIFEST_A, declaration()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(objects.policies).toEqual([]);
  });

  it('refuses a user who is not a member of the tenant', async () => {
    const { service } = build();
    await expect(
      service.requestUpload(
        caller('0198f0a0-0000-7000-8000-0000000000ff'),
        MANIFEST_A,
        declaration(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('answers not-found for a manifest of another tenant, without granting', async () => {
    const { service, objects } = build();
    await expect(
      service.requestUpload(caller(ADMIN_A), MANIFEST_B, declaration()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(objects.policies).toEqual([]);
  });

  it('refuses a manifest that already holds the maximum number of objects', async () => {
    const { service, tables, rejected } = build({ settings: { maxObjectsPerManifest: 1 } });
    manifestsOf(tables, TENANT_A)[MANIFEST_A] = [
      {
        uploadId: UPLOAD_3,
        kind: 'postman',
        objectKey: keyFor(UPLOAD_3, 'c.json'),
        sha256: 'b'.repeat(64),
        sizeBytes: 3,
        contentType: 'application/json',
        status: 'uploaded_pending_scan',
      },
    ];
    await expect(
      service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration()),
    ).rejects.toMatchObject({
      problemCode: 'scope_manifest_full',
    });
    expect(rejected).toEqual(['manifest_full']);
  });
});

describe('InputManifestUploadService.completeUpload (SCOPE-006)', () => {
  it('registers the object with the size, type and sha256 the store reports, pending scan', async () => {
    const { service, objects, tables, audit, results } = build();
    await service.requestUpload(
      caller(ADMIN_A),
      MANIFEST_A,
      declaration({ sizeBytes: SPEC_BYTES.byteLength }),
    );
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json; charset=utf-8', 'openapi'),
    );

    const result = await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);

    expect(result).toEqual({
      created: true,
      object: {
        uploadId: UPLOAD_1,
        kind: 'openapi',
        objectKey: keyFor(UPLOAD_1, 'api.json'),
        sha256: sha256Hex(SPEC_BYTES),
        sizeBytes: SPEC_BYTES.byteLength,
        contentType: 'application/json',
        status: 'uploaded_pending_scan',
      },
    });
    expect(manifestsOf(tables, TENANT_A)[MANIFEST_A]).toEqual([result.object]);
    expect(audit.events.at(-1)).toMatchObject({
      action: 'scope.manifest.upload_completed',
      metadata: {
        objectKey: keyFor(UPLOAD_1, 'api.json'),
        sha256: sha256Hex(SPEC_BYTES),
        kind: 'openapi',
      },
    });
    expect(results.at(-1)).toEqual({ kind: 'openapi', result: 'completed' });
  });

  it('answers the same object on a replay and registers nothing new', async () => {
    const { service, objects, tables } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    const first = await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);
    const replay = await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);
    expect(replay).toEqual({ created: false, object: first.object });
    expect(manifestsOf(tables, TENANT_A)[MANIFEST_A]).toHaveLength(1);
  });

  it('answers the registered twin and removes the new copy when the bytes are already registered', async () => {
    const { service, objects, tables } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    const first = await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);
    objects.put(
      keyFor(UPLOAD_2, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );

    const second = await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_2);

    expect(second).toEqual({ created: false, object: first.object });
    expect(objects.deleted).toEqual([keyFor(UPLOAD_2, 'api.json')]);
    expect(manifestsOf(tables, TENANT_A)[MANIFEST_A]).toHaveLength(1);
  });

  it('answers scope_object_missing when nothing was uploaded under the upload id', async () => {
    const { service } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toMatchObject({
      problemCode: 'scope_object_missing',
    });
  });

  it('refuses a stored type outside the allowlist for the kind, and removes the object', async () => {
    const { service, objects, tables, rejected } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(keyFor(UPLOAD_1, 'api.json'), uploadedAs(SPEC_BYTES, 'text/html', 'openapi'));
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toMatchObject({
      problemCode: 'scope_upload_type_not_allowed',
    });
    expect(objects.deleted).toEqual([keyFor(UPLOAD_1, 'api.json')]);
    expect(manifestsOf(tables, TENANT_A)[MANIFEST_A]).toEqual([]);
    expect(rejected).toEqual(['type_not_allowed']);
  });

  it('refuses an object whose kind metadata is missing or unknown', async () => {
    const { service, objects } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', undefined),
    );
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toMatchObject({
      problemCode: 'scope_upload_type_not_allowed',
    });
  });

  it('refuses a zero-byte object with scope_empty_upload', async () => {
    const { service, objects } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(new Uint8Array(0), 'application/json', 'openapi'),
    );
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toMatchObject({
      problemCode: 'scope_empty_upload',
    });
    expect(objects.deleted).toEqual([keyFor(UPLOAD_1, 'api.json')]);
  });

  it('refuses an object the store reports over the size limit, even when the declaration fit', async () => {
    const { service, objects } = build({ settings: { maxBytes: 5 } });
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration({ sizeBytes: 5 }));
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toMatchObject({
      problemCode: 'scope_upload_too_large',
    });
    expect(objects.deleted).toEqual([keyFor(UPLOAD_1, 'api.json')]);
  });

  it('answers not-found for another tenant before any store read', async () => {
    const { service, objects } = build();
    const listKeys = vi.spyOn(objects, 'listKeys');
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_B, UPLOAD_1),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(listKeys).not.toHaveBeenCalled();
  });

  it('keeps tenant B upload ids in tenant B: tenant A cannot register them', async () => {
    const { service, objects } = build();
    objects.put(
      keyFor(UPLOAD_1, 'api.json', TENANT_B, MANIFEST_B),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await expect(
      service.completeUpload(caller(ADMIN_A), MANIFEST_B, UPLOAD_1),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.completeUpload(caller(ADMIN_B, TENANT_B), MANIFEST_B, UPLOAD_1),
    ).resolves.toMatchObject({
      created: true,
    });
  });
});

describe('InputManifestUploadService.deleteUpload (SCOPE-006)', () => {
  it('removes a registered upload that is still pending scan, from the store and the manifest', async () => {
    const { service, objects, tables, audit } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await service.completeUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);

    await service.deleteUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);

    expect(objects.deleted).toEqual([keyFor(UPLOAD_1, 'api.json')]);
    expect(manifestsOf(tables, TENANT_A)[MANIFEST_A]).toEqual([]);
    expect(audit.events.at(-1)).toMatchObject({
      action: 'scope.manifest.upload_deleted',
      metadata: { uploadId: UPLOAD_1 },
    });
  });

  it('removes a granted upload whose object was never registered', async () => {
    const { service, objects } = build();
    await service.requestUpload(caller(ADMIN_A), MANIFEST_A, declaration());
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await service.deleteUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_1);
    expect(objects.deleted).toEqual([keyFor(UPLOAD_1, 'api.json')]);
  });

  it('answers not-found for an unknown upload id', async () => {
    const { service, objects } = build();
    await expect(
      service.deleteUpload(caller(ADMIN_A), MANIFEST_A, UPLOAD_2),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(objects.deleted).toEqual([]);
  });

  it('answers not-found for another tenant and deletes nothing', async () => {
    const { service, objects } = build();
    objects.put(
      keyFor(UPLOAD_1, 'api.json', TENANT_B, MANIFEST_B),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await expect(
      service.deleteUpload(caller(ADMIN_A), MANIFEST_B, UPLOAD_1),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(objects.deleted).toEqual([]);
  });

  it('refuses a member without assessment:create', async () => {
    const { service, objects } = build();
    objects.put(
      keyFor(UPLOAD_1, 'api.json'),
      uploadedAs(SPEC_BYTES, 'application/json', 'openapi'),
    );
    await expect(
      service.deleteUpload(caller(AUDITOR_A), MANIFEST_A, UPLOAD_1),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(objects.deleted).toEqual([]);
  });
});
