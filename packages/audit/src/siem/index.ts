// SIEM export framework (AUDIT-004, F34, CONTEXT_PACK §8.6, §8.8): subscriptions, durable cursors, the batching
// dispatcher and the connector seam. The concrete destinations are AUDIT-009..012.
export {
  assertNoSecretsInConfig,
  SiemConfigError,
  type SiemConnector,
  type SiemDeliveryResult,
  type SiemTarget,
} from './connector.js';
export { matchesAuditExportFilters, parseAuditExportFilters } from './filters.js';
export { toSiemRecord, type SiemRecord } from './normalise.js';
export {
  AuditExportSecretGoneError,
  type AuditExportAudit,
  type AuditExportKind,
  type AuditExportMetrics,
  type AuditExportSecretResolver,
  type AuditExportStatus,
  type AuditExportStore,
  type AuditExportSubscription,
} from './ports.js';
export {
  chunk,
  createAuditExporter,
  CursorRaceError,
  type AuditExportDeps,
  type AuditExportOutcome,
} from './dispatch.js';
