import { type DynamicModule, Module } from '@nestjs/common';

import { createAuditEmitter } from '@blackwing/audit';

import { InputManifestUploadController } from './controller.js';
import { createInputManifestUploadMetrics } from './metrics.js';
import {
  InputManifestUploadService,
  type UploadAudit,
  type UploadManifestStore,
  type UploadSettings,
} from './service.js';
import { INPUT_MANIFEST_UPLOAD_SERVICE } from './tokens.js';
import { auditSqlTx } from '../assets/audit-tx.js';

import type { ApiConfig } from '../config.js';
import type { TenantTx } from '@blackwing/db';
import type { UploadObjectStore } from '@blackwing/evidence';
import type { Logger } from '@blackwing/logger';
import type { Registry } from 'prom-client';

const MILLISECONDS_PER_SECOND = 1000;

/** The upload limits of a configuration (`SCOPE_*`), in the units the service uses. */
export function uploadSettingsOf(
  config: Pick<
    ApiConfig,
    'SCOPE_UPLOAD_MAX_BYTES' | 'SCOPE_PRESIGN_TTL' | 'SCOPE_MANIFEST_MAX_OBJECTS'
  >,
): UploadSettings {
  return {
    maxBytes: config.SCOPE_UPLOAD_MAX_BYTES,
    presignTtlSeconds: Math.ceil(config.SCOPE_PRESIGN_TTL / MILLISECONDS_PER_SECOND),
    maxObjectsPerManifest: config.SCOPE_MANIFEST_MAX_OBJECTS,
  };
}

/** The audit writer of a deployment: the event is appended to the hash chain in the transaction of the change (§8.8). */
function auditInTenantTx(): UploadAudit<TenantTx> {
  const emitter = createAuditEmitter();
  return async (tx, event) => {
    await emitter.emitAuditInTx(auditSqlTx(tx), event);
  };
}

export interface InputManifestUploadModuleOptions {
  /** The manifest persistence: `InputManifestRepository` of @blackwing/db in a deployment, one tenant transaction per call. */
  readonly store: UploadManifestStore<TenantTx>;
  /** Writes an audit event inside the caller's transaction. Unset: the hash-chained ledger writer of this app. */
  readonly audit?: UploadAudit<TenantTx>;
  /** The object store the uploads land in (`s3UploadObjectStore` of @blackwing/evidence in a deployment). */
  readonly objects: UploadObjectStore;
  /** The bucket of input objects. */
  readonly bucket: string;
  /** Limits from configuration (see {@link uploadSettingsOf}). */
  readonly settings: UploadSettings;
  /** The API's metrics registry, so the upload counters appear on `/metrics`. */
  readonly registry: Registry;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/**
 * Input-manifest uploads (SCOPE-006): `/v1/input-manifests/:id/uploads`. Mounted through
 * `createApiApp({ imports: [InputManifestUploadModule.forRoot(...)] })` under the tenant guard, so every route answers
 * 401 without a principal (fail closed).
 */
@Module({})
export class InputManifestUploadModule {
  static forRoot(options: InputManifestUploadModuleOptions): DynamicModule {
    const service = new InputManifestUploadService<TenantTx>({
      store: options.store,
      objects: options.objects,
      bucket: options.bucket,
      audit: options.audit ?? auditInTenantTx(),
      metrics: createInputManifestUploadMetrics(options.registry),
      logger: options.logger,
      settings: options.settings,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      module: InputManifestUploadModule,
      controllers: [InputManifestUploadController],
      providers: [{ provide: INPUT_MANIFEST_UPLOAD_SERVICE, useValue: service }],
    };
  }
}
