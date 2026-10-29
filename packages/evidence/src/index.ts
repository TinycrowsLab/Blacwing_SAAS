/** Workspace package name of this package. */
export const name = '@blackwing/evidence';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { verifyEvidenceChain, type ChainedItem, type ChainVerdict } from './chain.js';
export { EvidenceIntegrityError, type EvidenceIntegrityReason } from './errors.js';
export {
  type BindEvidenceDeps,
  type BindEvidenceResult,
  bindEvidence,
  type EvidenceAudit,
  type EvidenceAuditEvent,
  type EvidenceBindingStore,
  type EvidenceRecord,
} from './bind.js';
export { assertMinimumEvidenceSet, requiredEvidence, type RequiredEvidence } from './minimum.js';
export {
  createObjectReader,
  type EvidenceObjectReader,
  type ObjectBytesSource,
  s3ObjectBytesSource,
} from './objects.js';
export { type EvidenceMetrics, EVIDENCE_TRACER, noopEvidenceMetrics } from './telemetry.js';
