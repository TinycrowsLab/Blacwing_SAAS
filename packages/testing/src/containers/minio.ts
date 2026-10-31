import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  type ObjectLockRetentionMode,
  PutObjectLockConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Wait } from 'testcontainers';

import { TEST_IMAGES } from './images.js';
import {
  type ContainerOptions,
  containerCredential,
  resolveContainerOptions,
  startContainer,
  uniqueSuffix,
} from './runtime.js';

const MINIO_PORT = 9000;
const REGION = 'us-east-1';
const HTTP_OK = 200;
const ACCESS_KEY_SUFFIX_LENGTH = 10;
/** 32 random bytes as hex: the size of a MinIO static KMS key. */
const KMS_KEY_HEX_LENGTH = 64;

/** Options for {@link withMinio}. */
export interface WithMinioOptions extends ContainerOptions {
  /** Default retention applied to every new object version in the bucket. Off by default. */
  readonly defaultRetention?: { readonly mode: ObjectLockRetentionMode; readonly days: number };
  /** Name of a static KMS key to create for SSE-KMS (with encryption context). Off by default. */
  readonly kmsKeyId?: string;
}

/** A MinIO server and an Object Lock-enabled bucket created for this call. */
export interface MinioHandle {
  readonly service: 'minio';
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** Bucket with Object Lock enabled (and therefore versioning), unique to this call. */
  readonly bucket: string;
  /** The static KMS key name, when {@link WithMinioOptions.kmsKeyId} was set. */
  readonly kmsKeyId?: string;
  /** AWS SDK v3 S3 client (§5: the only way to talk to object storage), path-style. */
  readonly client: S3Client;
  readonly reused: boolean;
  /** Docker id of the container (for debugging and leak checks). */
  readonly containerId: string;
  logs(): string;
  /** Removes this call's bucket when the server is reused, closes the client, stops the container. Idempotent. */
  stop(): Promise<void>;
}

/** Starts MinIO (pinned by digest) and creates a bucket with Object Lock enabled. */
export async function withMinio(options: WithMinioOptions = {}): Promise<MinioHandle> {
  const { image, reuse, startupTimeoutMs } = resolveContainerOptions(options, TEST_IMAGES.minio);
  const credentials = {
    accessKeyId: `bwtest${containerCredential('minio:user', reuse).slice(0, ACCESS_KEY_SUFFIX_LENGTH)}`,
    secretAccessKey: containerCredential('minio:password', reuse),
  };
  const kmsEnv =
    options.kmsKeyId === undefined
      ? {}
      : {
          // MinIO's static KMS: `<key name>:<base64 of 32 bytes>`. Per run, so no key is shared between runs.
          MINIO_KMS_SECRET_KEY: `${options.kmsKeyId}:${Buffer.from(
            (
              containerCredential('minio:kms:a', reuse) + containerCredential('minio:kms:b', reuse)
            ).slice(0, KMS_KEY_HEX_LENGTH),
            'hex',
          ).toString('base64')}`,
        };
  const started = await startContainer({
    service: 'minio',
    image,
    ports: [MINIO_PORT],
    env: {
      MINIO_ROOT_USER: credentials.accessKeyId,
      MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
      ...kmsEnv,
    },
    command: ['server', '/data', '--address', `:${MINIO_PORT}`],
    wait: Wait.forHttp('/minio/health/ready', MINIO_PORT).forStatusCode(HTTP_OK),
    reuse,
    startupTimeoutMs,
  });
  const endpoint = `http://${started.container.getHost()}:${started.container.getMappedPort(MINIO_PORT)}`;
  const client = new S3Client({ endpoint, region: REGION, credentials, forcePathStyle: true });
  const bucket = `bw-test-${uniqueSuffix()}`;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      if (started.reused) await emptyAndDeleteBucket(client, bucket);
    } finally {
      client.destroy();
      await started.stop();
    }
  };

  try {
    await client.send(
      new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }),
    );
    if (options.defaultRetention !== undefined) {
      const { mode, days } = options.defaultRetention;
      await client.send(
        new PutObjectLockConfigurationCommand({
          Bucket: bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: mode, Days: days } },
          },
        }),
      );
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }

  return {
    service: 'minio',
    endpoint,
    region: REGION,
    credentials,
    bucket,
    ...(options.kmsKeyId === undefined ? {} : { kmsKeyId: options.kmsKeyId }),
    client,
    reused: started.reused,
    containerId: started.containerId,
    logs: () => started.logs(),
    stop,
  };
}

/**
 * Best-effort cleanup on a reused server: deletes every version (bypassing GOVERNANCE retention), then
 * the bucket. Versions under COMPLIANCE retention cannot be deleted by design and are left to expire.
 */
async function emptyAndDeleteBucket(client: S3Client, bucket: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await client.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
        ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
      }),
    );
    const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
    await Promise.all(
      versions.map((v) =>
        client
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: v.Key,
              ...(v.VersionId === undefined ? {} : { VersionId: v.VersionId }),
              BypassGovernanceRetention: true,
            }),
          )
          .catch(() => undefined),
      ),
    );
    if (page.IsTruncated !== true) break;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
}
