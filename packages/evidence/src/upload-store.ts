import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

import { isMissingObject, s3ObjectBytesSource } from './objects.js';

/**
 * Object storage for customer uploads (SCOPE-006): a presigned POST policy the browser or CLI posts to, and the
 * store reads that the server trusts after the upload (size, type, bytes). The one S3 client of the process is
 * passed in; this module never builds a second one (§5).
 */

/** What a presigned POST may carry: the exact key, a `Content-Length` range and the `Content-Type` it must have. */
export interface PresignPostPolicy {
  readonly bucket: string;
  readonly key: string;
  /** Upper bound of the file size in bytes; the lower bound is 1 (an empty object is never accepted). */
  readonly maxBytes: number;
  /** The exact `Content-Type` the file part must carry. */
  readonly contentType: string;
  /** Extra metadata the file part must carry, bound by the policy (`x-amz-meta-*` names, values). */
  readonly metadata: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
}

/** The form a client posts: `url` and `fields` are signed; the `file` field goes last. */
export interface PresignedPostForm {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** What the store reports for one object, after the upload. Absent when the object does not exist. */
export interface StoredObjectHead {
  readonly contentType: string | undefined;
  readonly contentLength: number | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

/** The object store the upload service composes. Narrowed so a test can supply a fake without a network. */
export interface UploadObjectStore {
  presignPost(policy: PresignPostPolicy): Promise<PresignedPostForm>;
  head(bucket: string, key: string): Promise<StoredObjectHead | undefined>;
  /** Keys under `prefix`, in listing order; an empty list when none match. */
  listKeys(bucket: string, prefix: string, limit: number): Promise<readonly string[]>;
  getBytes(bucket: string, key: string): Promise<Uint8Array>;
  /** Deletes the current version. Under Object Lock the retained versions stay until their retention ends. */
  deleteObject(bucket: string, key: string): Promise<void>;
}

/** The S3/MinIO implementation of {@link UploadObjectStore}, over the process's AWS SDK v3 client. */
export function s3UploadObjectStore(client: S3Client): UploadObjectStore {
  const bytes = s3ObjectBytesSource(client);
  return {
    async presignPost(policy) {
      const { url, fields } = await createPresignedPost(client, {
        Bucket: policy.bucket,
        Key: policy.key,
        Fields: { 'Content-Type': policy.contentType, ...policy.metadata },
        Conditions: [
          ['eq', '$key', policy.key],
          ['eq', '$Content-Type', policy.contentType],
          ['content-length-range', 1, policy.maxBytes],
          ...Object.entries(policy.metadata).map(([name, value]): ['eq', string, string] => [
            'eq',
            `$${name}`,
            value,
          ]),
        ],
        Expires: policy.expiresInSeconds,
      });
      return { url, fields };
    },
    async head(bucket, key) {
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          contentType: response.ContentType,
          contentLength: response.ContentLength,
          metadata: response.Metadata ?? {},
        };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        throw error;
      }
    },
    async listKeys(bucket, prefix, limit) {
      const response = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: limit }),
      );
      return (response.Contents ?? []).flatMap((item) =>
        item.Key === undefined ? [] : [item.Key],
      );
    },
    getBytes: bytes.getBytes,
    async deleteObject(bucket, key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
