/** Workspace package name of this package. */
export const name = '@blackwing/audit';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// emitAudit (AUDIT-003, F34, CONTEXT_PACK §8.8): the single sanctioned writer of the audit ledger.
export { AuditEventInvalidError } from './errors.js';
export { type AuditEventInput, type AuditEventDraft, deriveAuditEventId } from './draft.js';
export {
  appendAuditOutboxPayload,
  type AuditEmitter,
  type AuditEmitterDeps,
  createAuditEmitter,
  toOutboxMessage,
} from './emit.js';
export {
  type AuditChainHead,
  type AuditChainRow,
  type AuditChainStore,
  appendToChain,
  createPgChainStore,
} from './chain.js';
export {
  AUDIT_OUTBOX_TYPE,
  type AuditEmitPath,
  type AuditMetadataSpill,
  type AuditMetrics,
  type AuditOutbox,
  type AuditOutboxMessage,
  type AuditSpanRunner,
  type AuditSqlTx,
} from './ports.js';
export { createTextRedactor, isSecretKey, redactValue } from './redact.js';
export {
  type AuditDelivery,
  auditConfigChange,
  auditExport,
  auditGateDecision,
  auditLogin,
  configChangeInput,
  exportInput,
  type GateDecision,
  gateDecisionInput,
  type GateNumber,
  loginInput,
} from './wrappers.js';
