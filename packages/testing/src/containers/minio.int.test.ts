// withMinio: an Object Lock bucket, put/get, and proof that a locked version cannot be deleted.

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type MinioHandle, withMinio } from './minio.js';
import { surfaceContainerLogsOnFailure } from '../vitest/index.js';

let minio: MinioHandle | undefined;
const handle = (): MinioHandle => {
  if (minio === undefined) throw new Error('withMinio did not start');
  return minio;
};

beforeAll(async () => {
  minio = await withMinio({ defaultRetention: { mode: 'GOVERNANCE', days: 1 } });
});
afterAll(async () => {
  await minio?.stop();
});
surfaceContainerLogsOnFailure(() => [minio]);

describe('withMinio', () => {
  it('creates a bucket with Object Lock enabled and the requested default retention', async () => {
    const config = await handle().client.send(
      new GetObjectLockConfigurationCommand({ Bucket: handle().bucket }),
    );
    expect(config.ObjectLockConfiguration?.ObjectLockEnabled).toBe('Enabled');
    expect(config.ObjectLockConfiguration?.Rule?.DefaultRetention).toMatchObject({
      Mode: 'GOVERNANCE',
      Days: 1,
    });
  });

  it('stores and returns an object, retained under object lock', async () => {
    const key = 'evidence/ten_x/run_y/response.txt';
    const put = await handle().client.send(
      new PutObjectCommand({
        Bucket: handle().bucket,
        Key: key,
        Body: 'HTTP/1.1 200 OK',
        ContentType: 'text/plain',
      }),
    );
    expect(put.VersionId).toBeTruthy();

    const got = await handle().client.send(
      new GetObjectCommand({ Bucket: handle().bucket, Key: key }),
    );
    expect(await got.Body?.transformToString()).toBe('HTTP/1.1 200 OK');

    const retention = await handle().client.send(
      new GetObjectRetentionCommand({ Bucket: handle().bucket, Key: key }),
    );
    expect(retention.Retention?.Mode).toBe('GOVERNANCE');
    expect(retention.Retention?.RetainUntilDate?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  it('refuses to delete a locked object version without a governance bypass', async () => {
    const key = 'evidence/locked.bin';
    const put = await handle().client.send(
      new PutObjectCommand({ Bucket: handle().bucket, Key: key, Body: 'locked' }),
    );
    await expect(
      handle().client.send(
        new DeleteObjectCommand({ Bucket: handle().bucket, Key: key, VersionId: put.VersionId }),
      ),
    ).rejects.toThrow(/WORM protected/);
    const got = await handle().client.send(
      new GetObjectCommand({ Bucket: handle().bucket, Key: key, VersionId: put.VersionId }),
    );
    expect(await got.Body?.transformToString()).toBe('locked');
  });

  it('names the bucket uniquely per call', () => {
    expect(handle().bucket).toMatch(/^bw-test-[0-9a-f]{12}$/);
  });
});
