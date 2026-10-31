import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { sha256Hex } from '@blackwing/crypto';
import { ValidationError } from '@blackwing/errors';

const HTTP_NOT_FOUND = 404;

/** True when S3 says the object is absent (a normal answer for a head or a read, never a failure to surface). */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === HTTP_NOT_FOUND;
}

/** The key prefix of one tenant's objects (CONTEXT_PACK §8.6; infra denies PutObject outside `t/*`). */
export function tenantKeyPrefix(tenantId: string): string {
  return `t/${tenantId}/`;
}

/**
 * Reads the bytes behind an evidence object key. The binding re-hashes them, so a stored digest that no longer
 * matches its bytes is caught before anything is confirmed (§8.8). Throws when the object is missing or unreadable.
 */
export interface EvidenceObjectReader {
  readonly sha256Of: (objectKey: string) => Promise<string>;
}

/** The one S3 call the reader needs. Narrowed so a test can supply a fake without a network. */
export interface ObjectBytesSource {
  readonly getBytes: (bucket: string, key: string) => Promise<Uint8Array>;
}

/** Reads evidence bytes from S3 or MinIO (the AWS SDK v3 client, the only object-storage path, §5). */
export function s3ObjectBytesSource(client: Pick<S3Client, 'send'>): ObjectBytesSource {
  return {
    async getBytes(bucket, key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.Body === undefined) throw new Error('evidence object has no body');
      return response.Body.transformToByteArray();
    },
  };
}

/**
 * An object reader for one tenant. A key outside that tenant's prefix is refused before any read, so one tenant's
 * binding can never hash another tenant's bytes (§8.6).
 */
export function createObjectReader(options: {
  readonly source: ObjectBytesSource;
  readonly bucket: string;
  readonly tenantId: string;
}): EvidenceObjectReader {
  const prefix = tenantKeyPrefix(options.tenantId);
  return {
    async sha256Of(objectKey) {
      if (!objectKey.startsWith(prefix)) {
        throw new ValidationError('evidence object is outside this tenant');
      }
      return sha256Hex(await options.source.getBytes(options.bucket, objectKey));
    },
  };
}
