// The write-once evidence object store (EVIDENCE #731, CONTEXT_PACK §5, §8.6, §8.7, §8.8). Evidence bytes go to S3 with
// Object Lock in COMPLIANCE mode, under one tenant's prefix, encrypted with that tenant's key context. The store refuses to
// start unless the bucket has Object Lock, and it never overwrites or deletes an object that is still locked.

import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { z } from 'zod';

import { sha256Hex } from '@blackwing/crypto';
import { AppError, NotFoundError, ValidationError } from '@blackwing/errors';
import { newId } from '@blackwing/ids';

import { EvidenceImmutableError } from './errors.js';
import { isMissingObject, tenantKeyPrefix } from './objects.js';
import { type EvidenceStoreMetrics, log, noopEvidenceStoreMetrics, tracer } from './telemetry.js';

const MS_PER_DAY = 86_400_000;
/** S3 needs parts of at least 5 MiB (the last one may be smaller); larger objects go through multipart upload. */
const MULTIPART_PART_BYTES = 8_388_608; // 8 MiB
const UPLOAD_QUEUE_SIZE = 4;
const MAX_CONTENT_TYPE_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** `t/<tenantId>/runs/<runId>/<kind>/<uuidv7>`: the only shape the store writes or reads. */
const OBJECT_KEY_PATTERN =
  /^t\/([0-9a-f-]{36})\/runs\/([0-9a-f-]{36})\/([a-z][a-z0-9-]{0,31})\/([0-9a-f-]{36})$/;
/** S3 refusals of a locked version, from MinIO and AWS. Mapped to {@link EvidenceImmutableError}. */
const WORM_REFUSAL = /WORM protected|ObjectLocked|object is locked/i;

const uuidText = z.string().regex(UUID_PATTERN, 'must be a lowercase UUID');
const kindText = z.string().regex(KIND_PATTERN, 'must be a lowercase slug');
const putInputSchema = z.object({
  tenantId: uuidText,
  key: z.object({ runId: uuidText, kind: kindText }),
  contentType: z.string().min(1).max(MAX_CONTENT_TYPE_LENGTH),
  retentionUntil: z.date().optional(),
  legalHold: z.boolean().default(false),
});

/** The fixed settings of one bucket. Parsed by the app from `@blackwing/config` (`evidenceStoreEnvSchema`). */
export interface EvidenceStoreConfig {
  readonly bucket: string;
  /** Only COMPLIANCE is written by default. GOVERNANCE is for the dev bucket, where operators can bypass it. */
  readonly objectLockMode: 'COMPLIANCE' | 'GOVERNANCE';
  /** The retention floor, in days, counted from the write. A requested retention can only be longer. */
  readonly defaultRetentionDays: number;
  /** `aws:kms` on AWS, `minio` for the dev stand-in. Both send SSE-KMS with the per-tenant encryption context. */
  readonly sse: 'aws:kms' | 'minio';
  /** The bucket's own key: the AWS KMS CMK, or the MinIO KMS key name in dev. */
  readonly kmsKeyId: string;
}

/** The per-tenant key gate. `TenantKekService.ensureTenantKek` satisfies it: it fails when OpenBao is unreachable. */
export interface TenantKeyGate {
  ensureTenantKek(tenantId: string): Promise<unknown>;
}

export interface EvidenceStoreDeps {
  /** The one AWS SDK v3 S3 client of the process (§5). */
  readonly client: S3Client;
  readonly config: EvidenceStoreConfig;
  readonly keys: TenantKeyGate;
  readonly metrics?: EvidenceStoreMetrics;
  /** Source of object ids. Defaults to UUIDv7. A test may pin it to prove write-once on a repeated key. */
  readonly newObjectId?: () => string;
  /** The client clock, used only to floor the requested retention. S3 enforces retention on its own server time. */
  readonly now?: () => Date;
}

export interface PutEvidenceOptions {
  readonly contentType: string;
  /** Requested retention end. A value earlier than the default floor is raised to the floor. */
  readonly retentionUntil?: Date;
  readonly legalHold?: boolean;
}

export interface PutEvidenceResult {
  readonly objectKey: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly size: number;
  /** The retain-until the server reports for this version. The app records this value, not its own clock. */
  readonly retainUntil: Date;
}

export interface EvidenceObjectHead {
  readonly objectKey: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly size: number;
  readonly retainUntil: Date | undefined;
  readonly legalHold: boolean;
}

/** Object storage for evidence. Every method takes the tenant and refuses a key outside that tenant's prefix. */
export interface EvidenceStore {
  put(
    tenantId: string,
    key: { readonly runId: string; readonly kind: string },
    body: Uint8Array,
    options: PutEvidenceOptions,
  ): Promise<PutEvidenceResult>;
  getStream(tenantId: string, objectKey: string): Promise<Readable>;
  /** The stored digest and size for an integrity check. Undefined when the object is absent. */
  headObject(tenantId: string, objectKey: string): Promise<EvidenceObjectHead | undefined>;
  /** Deletes a version only once its retention has ended and no legal hold is on. Otherwise refuses. */
  delete(tenantId: string, objectKey: string): Promise<void>;
}

/** The SSE-KMS headers that bind an object to one tenant. The context is base64 of `{"tenantId":"<id>"}`. */
function encryptionContextHeader(tenantId: string): string {
  return Buffer.from(JSON.stringify({ tenantId }), 'utf8').toString('base64');
}

function parseOrRefuse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError('evidence store input is invalid');
  return result.data;
}

/** Refuses a key that is not one of this tenant's objects, before any S3 call (§8.6). */
function refuseForeignKey(tenantId: string, objectKey: string): void {
  if (!OBJECT_KEY_PATTERN.test(objectKey) || !objectKey.startsWith(tenantKeyPrefix(tenantId))) {
    throw new ValidationError('evidence object is outside this tenant');
  }
}

/** Fails the process start when the bucket cannot keep evidence write-once (§8.8). */
async function assertObjectLockEnabled(client: S3Client, bucket: string): Promise<void> {
  let enabled: string | undefined;
  try {
    const response = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    enabled = response.ObjectLockConfiguration?.ObjectLockEnabled;
  } catch (error) {
    if (!(error instanceof Error && error.name === 'ObjectLockConfigurationNotFoundError')) {
      throw error;
    }
  }
  if (enabled !== 'Enabled') {
    throw new AppError(
      'INTERNAL',
      'evidence bucket does not have Object Lock enabled; refusing to start',
    );
  }
}

/**
 * Builds the evidence store. Resolves only when the bucket has Object Lock enabled; otherwise it rejects, and the app
 * does not start. Object keys are `t/<tenantId>/runs/<runId>/<kind>/<uuidv7>`.
 */
export async function createEvidenceStore(deps: EvidenceStoreDeps): Promise<EvidenceStore> {
  const { client, config, keys } = deps;
  const metrics = deps.metrics ?? noopEvidenceStoreMetrics;
  const newObjectId = deps.newObjectId ?? (() => newId());
  const now = deps.now ?? (() => new Date());

  await assertObjectLockEnabled(client, config.bucket);
  log.info(
    { bucket: config.bucket, objectLockMode: config.objectLockMode, sse: config.sse },
    'evidence object lock verified',
  );

  async function headAt(objectKey: string): Promise<EvidenceObjectHead | undefined> {
    let response;
    try {
      response = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
    const sha256 = response.Metadata?.sha256;
    if (
      sha256 === undefined ||
      response.ContentLength === undefined ||
      response.VersionId === undefined
    ) {
      throw new AppError('INTERNAL', 'evidence object has no stored digest or version');
    }
    return {
      objectKey,
      versionId: response.VersionId,
      sha256,
      size: response.ContentLength,
      retainUntil: response.ObjectLockRetainUntilDate,
      legalHold: response.ObjectLockLegalHoldStatus === 'ON',
    };
  }

  async function writeOnce(
    tenantId: string,
    key: { readonly runId: string; readonly kind: string },
    body: Uint8Array,
    options: {
      readonly contentType: string;
      readonly retainUntil: Date;
      readonly legalHold: boolean;
    },
  ): Promise<PutEvidenceResult> {
    // Fail closed first: no tenant key, no write (§8.7). An unreachable OpenBao throws here.
    await keys.ensureTenantKek(tenantId);
    const objectKey = `t/${tenantId}/runs/${key.runId}/${key.kind}/${parseOrRefuse(uuidText, newObjectId())}`;
    const sha256 = sha256Hex(body);
    if ((await headAt(objectKey)) !== undefined) {
      throw new EvidenceImmutableError(
        'evidence object key already exists; the store is write-once',
      );
    }
    const upload = new Upload({
      client,
      partSize: MULTIPART_PART_BYTES,
      queueSize: UPLOAD_QUEUE_SIZE,
      params: {
        Bucket: config.bucket,
        Key: objectKey,
        Body: body,
        ContentType: options.contentType,
        Metadata: { sha256 },
        ObjectLockMode: config.objectLockMode,
        ObjectLockRetainUntilDate: options.retainUntil,
        ObjectLockLegalHoldStatus: options.legalHold ? 'ON' : 'OFF',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.kmsKeyId,
        SSEKMSEncryptionContext: encryptionContextHeader(tenantId),
      },
    });
    const uploaded = await upload.done();
    const versionId = uploaded.VersionId;
    if (versionId === undefined)
      throw new AppError('INTERNAL', 'evidence write returned no version');

    // Read the retention back from S3: the lock is proven by the server, not assumed from the request.
    const retention = await client.send(
      new GetObjectRetentionCommand({
        Bucket: config.bucket,
        Key: objectKey,
        VersionId: versionId,
      }),
    );
    const retainUntil = retention.Retention?.RetainUntilDate;
    if (retention.Retention?.Mode !== config.objectLockMode || retainUntil === undefined) {
      throw new AppError('INTERNAL', 'evidence object is not retained: object lock did not apply');
    }
    return {
      objectKey,
      versionId,
      sha256,
      size: body.byteLength,
      retainUntil,
    };
  }

  return {
    async put(tenantId, key, body, options) {
      // Refusals count as failed writes too, so the put metric and span cover every call.
      return tracer.startActiveSpan(
        'evidence.put',
        { attributes: { tenantId, kind: key.kind, size: body.byteLength } },
        async (span) => {
          try {
            const input = parseOrRefuse(putInputSchema, {
              tenantId,
              key,
              contentType: options.contentType,
              retentionUntil: options.retentionUntil,
              legalHold: options.legalHold,
            });
            const floor = new Date(now().getTime() + config.defaultRetentionDays * MS_PER_DAY);
            const requested = input.retentionUntil ?? floor;
            const retainUntil = requested.getTime() > floor.getTime() ? requested : floor;
            const result = await writeOnce(input.tenantId, input.key, body, {
              contentType: input.contentType,
              retainUntil,
              legalHold: input.legalHold,
            });
            metrics.put('ok');
            metrics.bytes(result.size);
            return result;
          } catch (error) {
            metrics.put('error');
            span.recordException(error instanceof Error ? error : new Error('evidence put failed'));
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },

    async getStream(tenantId, objectKey) {
      parseOrRefuse(uuidText, tenantId);
      refuseForeignKey(tenantId, objectKey);
      let response;
      try {
        response = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }),
        );
      } catch (error) {
        if (isMissingObject(error)) throw new NotFoundError('evidence object not found');
        throw error;
      }
      if (!(response.Body instanceof Readable)) {
        throw new AppError('INTERNAL', 'evidence object has no readable body');
      }
      return response.Body;
    },

    async headObject(tenantId, objectKey) {
      parseOrRefuse(uuidText, tenantId);
      refuseForeignKey(tenantId, objectKey);
      return headAt(objectKey);
    },

    async delete(tenantId, objectKey) {
      parseOrRefuse(uuidText, tenantId);
      refuseForeignKey(tenantId, objectKey);
      const head = await headAt(objectKey);
      if (head === undefined) throw new NotFoundError('evidence object not found');
      // Fail closed: a version without a retain-until is treated as locked, and so is one with a hold or a future date.
      const locked =
        head.legalHold ||
        head.retainUntil === undefined ||
        head.retainUntil.getTime() > now().getTime();
      if (locked) throw new EvidenceImmutableError();
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: objectKey,
            VersionId: head.versionId,
          }),
        );
      } catch (error) {
        if (error instanceof Error && WORM_REFUSAL.test(error.message)) {
          throw new EvidenceImmutableError();
        }
        throw error;
      }
    },
  };
}
