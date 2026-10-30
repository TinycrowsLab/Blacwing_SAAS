import { Counter, Histogram, type Registry } from 'prom-client';

import type { InputManifestUploadKind } from '@blackwing/contracts';

/** Why an upload was refused before it was registered. Labels are a closed set. */
export type UploadRejectReason =
  'empty' | 'too_large' | 'type_not_allowed' | 'manifest_full' | 'object_missing' | 'not_pending';

/** What happened to an upload. `duplicate` is a completed object whose bytes already register under this manifest. */
export type UploadResult = 'requested' | 'completed' | 'duplicate' | 'deleted';

/** Upload metrics (SCOPE-006 observability). Labels are closed sets: the kind, the result and the reason. */
export interface InputManifestUploadMetrics {
  result(kind: InputManifestUploadKind, result: UploadResult): void;
  sizeBytes(kind: InputManifestUploadKind, bytes: number): void;
  rejected(reason: UploadRejectReason): void;
}

const BYTES_PER_KIB = 1024;
const SIZE_BUCKET_BASE_BYTES = BYTES_PER_KIB;
const SIZE_BUCKET_GROWTH = 4;
const SIZE_BUCKET_COUNT = 9;
/** Powers of four from 1 KiB to 64 MiB, which covers the 25 MiB default limit with room to spare. */
const SIZE_BUCKETS_BYTES = Array.from(
  { length: SIZE_BUCKET_COUNT },
  (_, index) => SIZE_BUCKET_BASE_BYTES * SIZE_BUCKET_GROWTH ** index,
);

/** `scope_upload_total{kind,result}`, `scope_upload_size_bytes{kind}` and `scope_upload_rejected_total{reason}`. */
export function createInputManifestUploadMetrics(registry: Registry): InputManifestUploadMetrics {
  const total = new Counter({
    name: 'scope_upload_total',
    help: 'Input manifest upload operations by artefact kind and result.',
    labelNames: ['kind', 'result'],
    registers: [registry],
  });
  const size = new Histogram({
    name: 'scope_upload_size_bytes',
    help: 'Size in bytes of input manifest uploads, as read from the store on completion.',
    labelNames: ['kind'],
    buckets: SIZE_BUCKETS_BYTES,
    registers: [registry],
  });
  const rejected = new Counter({
    name: 'scope_upload_rejected_total',
    help: 'Input manifest upload operations refused, by reason.',
    labelNames: ['reason'],
    registers: [registry],
  });
  return {
    result: (kind, result) => {
      total.inc({ kind, result });
    },
    sizeBytes: (kind, bytes) => {
      size.observe({ kind }, bytes);
    },
    rejected: (reason) => {
      rejected.inc({ reason });
    },
  };
}
