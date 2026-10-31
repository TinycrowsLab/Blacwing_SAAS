import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Reads spec objects by key. `null` means the key does not exist; any other failure throws. The stager treats a
 * missing object as an integrity failure (fail closed), so an outage can never look like a clean empty input set.
 */
export interface InputObjectStore {
  getBytes(bucket: string, key: string): Promise<Uint8Array | null>;
}

/** The one S3 call the stager needs. Narrowed so tests supply a fake without a network. */
export function s3InputObjectStore(client: Pick<S3Client, 'send'>): InputObjectStore {
  return {
    async getBytes(bucket, key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (response.Body === undefined) return null;
        return await response.Body.transformToByteArray();
      } catch (error) {
        if (error instanceof Error && error.name === 'NoSuchKey') return null;
        throw error;
      }
    },
  };
}

export interface S3InputObjectStoreOptions {
  /** MinIO endpoint for local runs; omitted online (AWS endpoint resolution). */
  readonly endpoint?: string;
}

/**
 * Object store over AWS SDK v3 (MinIO locally with path-style addressing). The client is created on first use,
 * never at import time, so the controller can boot and report readiness without object storage.
 */
export function createS3InputObjectStore(
  options: S3InputObjectStoreOptions = {},
): InputObjectStore {
  let inner: InputObjectStore | undefined;
  const lazy = (): InputObjectStore => {
    if (inner === undefined) {
      const client = new S3Client({
        region: 'us-east-1',
        forcePathStyle: options.endpoint !== undefined,
        ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      });
      inner = s3InputObjectStore(client);
    }
    return inner;
  };
  return {
    getBytes: (bucket, key) => lazy().getBytes(bucket, key),
  };
}
