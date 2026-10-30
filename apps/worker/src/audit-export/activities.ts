import {
  createAuditEmitter,
  createAuditExporter,
  type AuditExportAudit,
  type AuditExportDeps,
  type AuditExportOutcome,
  type AuditExportMetrics,
  type AuditExportSecretResolver,
  type SiemConnector,
} from '@blackwing/audit';
import { toAuditSqlTx, withTenant, type Database } from '@blackwing/db';

import { auditExportSpan } from './metrics.js';
import { createPgAuditExportStore } from './store-pg.js';

import type { Logger } from '@blackwing/logger';

/**
 * The SIEM export as a Temporal activity (AUDIT-004, CONTEXT_PACK §8.8). One call exports one bounded window of one
 * subscription on the `connectors` queue; a schedule (or the export workflow) calls it again for the next window.
 * The worker never stores or logs a credential: the secret is resolved by reference, used for one delivery, and dropped.
 */

export interface AuditExportActivityDeps {
  readonly db: Database;
  /** The implemented destinations per kind (AUDIT-009..012 register theirs). An unlisted kind is refused. */
  readonly connectors: ReadonlyMap<string, SiemConnector>;
  /** Resolves a `secret_ref` through the SECRETS resolve API (`worker:connectors`, `connector_credential`). */
  readonly resolveSecret: AuditExportSecretResolver;
  /** Ledger events read per call (`AUDIT_EXPORT_BATCH`). */
  readonly batchSize: number;
  readonly metrics: AuditExportMetrics;
  readonly log: Pick<Logger, 'info' | 'warn'>;
  /** Test seam: the export audit writer (default: the ledger, in the tenant transaction). */
  readonly audit?: AuditExportAudit;
}

export interface AuditExportInput {
  /** The tenant that owns the subscription (the RLS context the activity runs under). */
  readonly tenantId: string;
  readonly subscriptionId: string;
}

export type AuditExportActivityResult = AuditExportOutcome | { readonly status: 'not_found' };

export interface AuditExportActivities {
  exportAuditBatchActivity(input: AuditExportInput): Promise<AuditExportActivityResult>;
}

const emitter = createAuditEmitter();

/** Builds the export activity over its ports. Idempotent per window: a re-run after a crash re-sends from the cursor. */
export function createAuditExportActivities(deps: AuditExportActivityDeps): AuditExportActivities {
  const store = createPgAuditExportStore(deps.db);
  const audit: AuditExportAudit =
    deps.audit ??
    (async (input) => {
      await withTenant(deps.db, input.tenantId, (tx) =>
        emitter.emitAuditInTx(toAuditSqlTx(tx), input),
      );
    });
  const exporterDeps: AuditExportDeps = {
    store,
    connectors: deps.connectors,
    resolveSecret: deps.resolveSecret,
    audit,
    metrics: deps.metrics,
    batchSize: deps.batchSize,
    span: auditExportSpan,
  };
  const exportOnce = createAuditExporter(exporterDeps);

  return {
    async exportAuditBatchActivity(input) {
      const subscription = await store.load(input.tenantId, input.subscriptionId);
      if (subscription === undefined) return { status: 'not_found' };
      const outcome = await exportOnce(subscription);
      // Logs carry ids, counts and cursor positions only: never the config, the credential or an event payload.
      const fields = {
        subscriptionId: input.subscriptionId,
        kind: subscription.kind,
        status: outcome.status,
        cursorSeq: outcome.cursorSeq,
        delivered: outcome.delivered,
      };
      if (outcome.status === 'failed') deps.log.warn(fields, 'audit export delivery failed');
      else deps.log.info(fields, 'audit export window processed');
      return outcome;
    },
  };
}
