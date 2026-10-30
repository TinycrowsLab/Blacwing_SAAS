// Presigned POST policies against MinIO (SCOPE-006): the store itself refuses an oversize file, a wrong type, a wrong
// kind, an empty file and a key the grant did not name. Run with `pnpm test:int` (Testcontainers).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { s3UploadObjectStore, type PresignPostPolicy } from '@blackwing/evidence';
import { type MinioHandle, withMinio } from '@blackwing/testing/containers';

let minio: MinioHandle | undefined;

beforeAll(async () => {
  minio = await withMinio();
});

afterAll(async () => {
  await minio?.stop();
});

function handle(): MinioHandle {
  if (minio === undefined) throw new Error('MinIO did not start');
  return minio;
}

const KEY = 'inputs/tenant-a/manifest-1/0198f0a0-0000-7000-8000-000000000101-api.json';
const BODY = new TextEncoder().encode('{"openapi":"3.1.0"}');

function policy(bucket: string, overrides: Partial<PresignPostPolicy> = {}): PresignPostPolicy {
  return {
    bucket,
    key: KEY,
    maxBytes: BODY.byteLength,
    contentType: 'application/json',
    metadata: { 'x-amz-meta-kind': 'openapi' },
    expiresInSeconds: 300,
    ...overrides,
  };
}

/** Posts the form as a browser would: every signed field, then the file last. */
async function post(
  form: { url: string; fields: Record<string, string> },
  file: Uint8Array,
  fieldOverrides: Record<string, string> = {},
  type = 'application/json',
): Promise<{ status: number; text: string }> {
  const body = new FormData();
  for (const [name, value] of Object.entries({ ...form.fields, ...fieldOverrides }))
    body.append(name, value);
  body.append('file', new Blob([file], { type }));
  const response = await fetch(form.url, { method: 'POST', body });
  return { status: response.status, text: await response.text() };
}

describe('presigned POST policy in the store (SCOPE-006, MinIO)', () => {
  it('accepts a file that matches the policy, then reports its stored size, type and kind', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const form = await store.presignPost(policy(bucket));
    expect((await post(form, BODY)).status).toBe(204);

    const head = await store.head(bucket, KEY);
    expect(head).toMatchObject({
      contentType: 'application/json',
      contentLength: BODY.byteLength,
      metadata: { kind: 'openapi' },
    });
    expect(await store.listKeys(bucket, KEY.slice(0, KEY.indexOf('0198')), 10)).toContain(KEY);
    expect(new TextDecoder().decode(await store.getBytes(bucket, KEY))).toBe('{"openapi":"3.1.0"}');
    await store.deleteObject(bucket, KEY);
    expect(await store.head(bucket, KEY)).toBeUndefined();
  });

  it('refuses a file over the declared size: S3 answers 400 EntityTooLarge and stores nothing', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const key = `${KEY}.oversize`;
    const form = await store.presignPost(policy(bucket, { key }));
    const result = await post(form, new Uint8Array(BODY.byteLength + 1).fill(0x20), { key });
    expect(result.status).toBe(400);
    expect(result.text).toContain('EntityTooLarge');
    expect(await store.head(bucket, key)).toBeUndefined();
  });

  it('refuses an empty file: S3 answers 400 EntityTooSmall and stores nothing', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const key = `${KEY}.empty`;
    const form = await store.presignPost(policy(bucket, { key }));
    const result = await post(form, new Uint8Array(0), { key });
    expect(result.status).toBe(400);
    expect(result.text).toContain('EntityTooSmall');
    expect(await store.head(bucket, key)).toBeUndefined();
  });

  it('refuses a Content-Type the policy does not name, with 403', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const key = `${KEY}.type`;
    const form = await store.presignPost(policy(bucket, { key }));
    expect((await post(form, BODY, { key, 'Content-Type': 'text/html' })).status).toBe(403);
  });

  it('refuses a metadata kind the policy does not name, with 403', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const key = `${KEY}.kind`;
    const form = await store.presignPost(policy(bucket, { key }));
    expect((await post(form, BODY, { key, 'x-amz-meta-kind': 'har' })).status).toBe(403);
  });

  it('refuses a key the grant did not name, with 403', async () => {
    const { client, bucket } = handle();
    const store = s3UploadObjectStore(client);
    const form = await store.presignPost(policy(bucket));
    expect((await post(form, BODY, { key: `${KEY}.other` })).status).toBe(403);
  });

  it('answers an absent object as undefined, not an error', async () => {
    const { client, bucket } = handle();
    expect(await s3UploadObjectStore(client).head(bucket, `${KEY}.never-written`)).toBeUndefined();
  });
});
