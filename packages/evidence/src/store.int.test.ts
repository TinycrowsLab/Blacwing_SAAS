// The evidence object store against MinIO with object locking: write-once, retain-until read back from the server,
// the per-tenant SSE-KMS encryption context on the wire, multipart writes, legal hold and the startup refusal.

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '@blackwing/crypto';
import { ValidationError } from '@blackwing/errors';
import { type MinioHandle, withMinio } from '@blackwing/testing/containers';
import { surfaceContainerLogsOnFailure } from '@blackwing/testing/vitest';

import { EvidenceImmutableError } from './errors.js';
import { createEvidenceStore, type EvidenceStore, type TenantKeyGate } from './store.js';

import type { EvidenceStoreMetrics } from './telemetry.js';

const TENANT_A = '018f0000-0000-7000-8000-00000000000a';
const TENANT_B = '018f0000-0000-7000-8000-00000000000b';
const RUN = '018f0000-0000-7000-8000-0000000000aa';
const KMS_KEY = 'bw-evidence-test-key';
const DAY_MS = 86_400_000;
const MULTIPART_BYTES = 12 * 1024 * 1024;

let minio: MinioHandle | undefined;
const handle = (): MinioHandle => {
  if (minio === undefined) throw new Error('withMinio did not start');
  return minio;
};
surfaceContainerLogsOnFailure(() => [minio]);

/** Records the SSE-KMS context header and the S3 operation of every request the client sends. */
const wire: {
  readonly contexts: { readonly key: string; readonly context: string }[];
  readonly commands: string[];
} = {
  contexts: [],
  commands: [],
};

const okGate: TenantKeyGate = { ensureTenantKek: () => Promise.resolve({ created: false }) };
const bytesOf = (text: string) => new TextEncoder().encode(text);

let store: EvidenceStore;

beforeAll(async () => {
  minio = await withMinio({ kmsKeyId: KMS_KEY });
  handle().client.middlewareStack.add(
    (next, context) => async (args) => {
      wire.commands.push(context.commandName ?? '');
      const request = args.request as { headers?: Record<string, string> };
      const context64 = request.headers?.['x-amz-server-side-encryption-context'];
      if (context64 !== undefined) {
        const { Key } = args.input as { Key?: string };
        wire.contexts.push({ key: Key ?? '', context: context64 });
      }
      return next(args);
    },
    { step: 'build', name: 'captureEvidenceWire' },
  );
  store = await createEvidenceStore({
    client: handle().client,
    config: {
      bucket: handle().bucket,
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 365,
      sse: 'minio',
      kmsKeyId: KMS_KEY,
    },
    keys: okGate,
  });
});

afterAll(async () => {
  await minio?.stop();
});

describe('createEvidenceStore against MinIO with object locking', () => {
  it('starts on an Object Lock bucket', () => {
    expect(store).toBeDefined();
  });

  it('refuses to start on a bucket without Object Lock', async () => {
    const plain = `bw-test-plain-${Date.now()}`;
    await handle().client.send(new CreateBucketCommand({ Bucket: plain }));
    await expect(
      createEvidenceStore({
        client: handle().client,
        config: {
          bucket: plain,
          objectLockMode: 'COMPLIANCE',
          defaultRetentionDays: 365,
          sse: 'minio',
          kmsKeyId: KMS_KEY,
        },
        keys: okGate,
      }),
    ).rejects.toThrow(/refusing to start/);
  });
});

describe('put: a write-once, retained, tenant-scoped object', () => {
  it('writes under the tenant prefix with COMPLIANCE retention the server reports back', async () => {
    const body = bytesOf('HTTP/1.1 200 OK');
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'response' }, body, {
      contentType: 'text/plain',
    });

    expect(result.objectKey).toMatch(
      new RegExp(`^t/${TENANT_A}/runs/${RUN}/response/[0-9a-f-]{36}$`),
    );
    expect(result.sha256).toBe(sha256Hex(body));
    expect(result.size).toBe(body.byteLength);
    const retention = await handle().client.send(
      new GetObjectRetentionCommand({
        Bucket: handle().bucket,
        Key: result.objectKey,
        VersionId: result.versionId,
      }),
    );
    expect(retention.Retention?.Mode).toBe('COMPLIANCE');
    expect(retention.Retention?.RetainUntilDate?.getTime()).toBe(result.retainUntil.getTime());
    expect(result.retainUntil.getTime()).toBeGreaterThan(Date.now() + 364 * DAY_MS);
  });

  it('sends the per-tenant SSE-KMS context, and a different one for another tenant', async () => {
    wire.contexts.length = 0;
    await store.put(TENANT_A, { runId: RUN, kind: 'trace' }, bytesOf('a'), {
      contentType: 'text/plain',
    });
    await store.put(TENANT_B, { runId: RUN, kind: 'trace' }, bytesOf('b'), {
      contentType: 'text/plain',
    });

    const contextOf = (tenantId: string) =>
      Buffer.from(JSON.stringify({ tenantId })).toString('base64');
    const forA = wire.contexts.filter((c) => c.key.startsWith(`t/${TENANT_A}/`));
    const forB = wire.contexts.filter((c) => c.key.startsWith(`t/${TENANT_B}/`));
    expect(forA.map((c) => c.context)).toEqual([contextOf(TENANT_A)]);
    expect(forB.map((c) => c.context)).toEqual([contextOf(TENANT_B)]);
  });

  it('stores SSE-KMS with the bucket key, read back from the object', async () => {
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'sse' }, bytesOf('kms'), {
      contentType: 'text/plain',
    });
    const head = await handle().client.send(
      new HeadObjectCommand({ Bucket: handle().bucket, Key: result.objectKey }),
    );
    expect(head.ServerSideEncryption).toBe('aws:kms');
  });

  it('reads the bytes back through getStream and returns the stored digest through headObject', async () => {
    const body = bytesOf('evidence bytes round trip');
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'roundtrip' }, body, {
      contentType: 'text/plain',
    });
    const stream = await store.getStream(TENANT_A, result.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).equals(Buffer.from(body))).toBe(true);
    expect(await store.headObject(TENANT_A, result.objectKey)).toMatchObject({
      sha256: sha256Hex(body),
      size: body.byteLength,
      versionId: result.versionId,
      legalHold: false,
    });
  });

  it('floors a requested retention that is too short, and keeps a longer one', async () => {
    const tooShort = await store.put(TENANT_A, { runId: RUN, kind: 'floor' }, bytesOf('x'), {
      contentType: 'text/plain',
      retentionUntil: new Date(Date.now() + 2 * DAY_MS),
    });
    expect(tooShort.retainUntil.getTime()).toBeGreaterThan(Date.now() + 364 * DAY_MS);
    const longer = new Date(Date.now() + 400 * DAY_MS);
    const kept = await store.put(TENANT_A, { runId: RUN, kind: 'floor' }, bytesOf('y'), {
      contentType: 'text/plain',
      retentionUntil: longer,
    });
    expect(Math.abs(kept.retainUntil.getTime() - longer.getTime())).toBeLessThan(DAY_MS / 24);
  });

  it('uses a multipart upload for an object larger than one part, and records its digest and size', async () => {
    wire.commands.length = 0;
    const body = new Uint8Array(MULTIPART_BYTES).map((_, index) => index % 251);
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'large' }, body, {
      contentType: 'application/octet-stream',
    });
    expect(wire.commands).toContain('CreateMultipartUploadCommand');
    expect(result.size).toBe(MULTIPART_BYTES);
    expect(await store.headObject(TENANT_A, result.objectKey)).toMatchObject({
      sha256: sha256Hex(body),
      size: MULTIPART_BYTES,
    });
  }, 120_000);

  it('places a legal hold on the version when asked, and the server reports it', async () => {
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'hold' }, bytesOf('held'), {
      contentType: 'text/plain',
      legalHold: true,
    });
    expect(await store.headObject(TENANT_A, result.objectKey)).toMatchObject({ legalHold: true });
  });
});

describe('write-once: the locked version is never overwritten or deleted', () => {
  it('refuses a second write to the same key, and leaves exactly one version', async () => {
    const fixed = '018f0000-0000-7000-8000-0000000000ee';
    const pinned = await createEvidenceStore({
      client: handle().client,
      config: {
        bucket: handle().bucket,
        objectLockMode: 'COMPLIANCE',
        defaultRetentionDays: 365,
        sse: 'minio',
        kmsKeyId: KMS_KEY,
      },
      keys: okGate,
      newObjectId: () => fixed,
    });
    await pinned.put(TENANT_A, { runId: RUN, kind: 'overwrite' }, bytesOf('first'), {
      contentType: 'text/plain',
    });
    await expect(
      pinned.put(TENANT_A, { runId: RUN, kind: 'overwrite' }, bytesOf('second'), {
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(EvidenceImmutableError);
    const listed = await handle().client.send(
      new ListObjectsV2Command({
        Bucket: handle().bucket,
        Prefix: `t/${TENANT_A}/runs/${RUN}/overwrite/`,
      }),
    );
    expect(listed.Contents?.map((item) => item.Key)).toEqual([
      `t/${TENANT_A}/runs/${RUN}/overwrite/${fixed}`,
    ]);
  });

  it('refuses the adapter delete of a version that is still retained', async () => {
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'locked' }, bytesOf('locked'), {
      contentType: 'text/plain',
    });
    await expect(store.delete(TENANT_A, result.objectKey)).rejects.toThrow(EvidenceImmutableError);
    expect(await store.headObject(TENANT_A, result.objectKey)).toMatchObject({
      sha256: sha256Hex(bytesOf('locked')),
    });
  });

  it('S3 itself refuses a raw delete of the locked version, so the lock is enforced below the adapter', async () => {
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'raw' }, bytesOf('raw'), {
      contentType: 'text/plain',
    });
    await expect(
      handle().client.send(
        new DeleteObjectCommand({
          Bucket: handle().bucket,
          Key: result.objectKey,
          VersionId: result.versionId,
        }),
      ),
    ).rejects.toThrow(/WORM protected/);
  });
});

describe('tenant isolation and fail-closed writes', () => {
  it('refuses to read another tenant object through the adapter, with no bytes returned', async () => {
    const result = await store.put(TENANT_A, { runId: RUN, kind: 'isolated' }, bytesOf('a only'), {
      contentType: 'text/plain',
    });
    await expect(store.getStream(TENANT_B, result.objectKey)).rejects.toThrow(ValidationError);
    await expect(store.headObject(TENANT_B, result.objectKey)).rejects.toThrow(ValidationError);
  });

  it('writes nothing when the tenant key is unavailable, so no unencrypted or unkeyed object lands', async () => {
    const down = await createEvidenceStore({
      client: handle().client,
      config: {
        bucket: handle().bucket,
        objectLockMode: 'COMPLIANCE',
        defaultRetentionDays: 365,
        sse: 'minio',
        kmsKeyId: KMS_KEY,
      },
      keys: { ensureTenantKek: () => Promise.reject(new Error('openbao unreachable')) },
    });
    await expect(
      down.put(TENANT_B, { runId: RUN, kind: 'nokey' }, bytesOf('x'), {
        contentType: 'text/plain',
      }),
    ).rejects.toThrow('openbao unreachable');
    const listed = await handle().client.send(
      new ListObjectsV2Command({
        Bucket: handle().bucket,
        Prefix: `t/${TENANT_B}/runs/${RUN}/nokey/`,
      }),
    );
    expect(listed.Contents ?? []).toEqual([]);
  });

  it('counts each write as ok with its bytes, and a failed write as an error', async () => {
    const seen = { ok: 0, error: 0, bytes: 0 };
    const metrics: EvidenceStoreMetrics = {
      put: (result) => {
        if (result === 'ok') seen.ok += 1;
        else seen.error += 1;
      },
      bytes: (size) => {
        seen.bytes += size;
      },
    };
    const counted = await createEvidenceStore({
      client: handle().client,
      config: {
        bucket: handle().bucket,
        objectLockMode: 'COMPLIANCE',
        defaultRetentionDays: 365,
        sse: 'minio',
        kmsKeyId: KMS_KEY,
      },
      keys: okGate,
      metrics,
    });
    await counted.put(TENANT_A, { runId: RUN, kind: 'metric' }, bytesOf('12345'), {
      contentType: 'text/plain',
    });
    await counted
      .put('not-a-uuid', { runId: RUN, kind: 'metric' }, bytesOf('x'), {
        contentType: 'text/plain',
      })
      .catch(() => undefined);
    expect(seen).toEqual({ ok: 1, error: 1, bytes: 5 });
  });
});
