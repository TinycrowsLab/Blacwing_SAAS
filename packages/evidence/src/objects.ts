import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { sha256Hex } from '@blackwing/crypto';
import { ValidationError } from '@blackwing/errors';

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
  const prefix = `${options.tenantId}/`;
  return {
    async sha256Of(objectKey) {
      if (!objectKey.startsWith(prefix)) {
        throw new ValidationError('evidence object is outside this tenant');
      }
      return sha256Hex(await options.source.getBytes(options.bucket, objectKey));
    },
  };
}
