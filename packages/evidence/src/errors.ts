import { AppError, type AppErrorOptions } from '@blackwing/errors';

/** Why a binding failed its integrity check. Recorded on the audit event and the log, never echoed to a client. */
export type EvidenceIntegrityReason = 'chain_broken' | 'sha256_mismatch' | 'object_unreadable';

/**
 * `EVIDENCE_INTEGRITY_FAILED` (422): an evidence item is missing its bytes, its digest does not match, or its chain
 * link is broken. The finding has been moved to Suspected before this is thrown, so the caller never confirms.
 */
export class EvidenceIntegrityError extends AppError {
  declare readonly code: 'EVIDENCE_INTEGRITY_FAILED';
  /** The stable failure class, for the caller and the audit trail. */
  readonly reason: EvidenceIntegrityReason;

  constructor(reason: EvidenceIntegrityReason, options: AppErrorOptions = {}) {
    super('EVIDENCE_INTEGRITY_FAILED', 'evidence integrity check failed', options);
    this.reason = reason;
  }
}

/**
 * `CONFLICT` (409): an evidence object is write-once. It cannot be overwritten, or deleted, while its retention runs
 * or while a legal hold is on. The store refuses before it calls S3, and maps S3's own WORM refusal to this error too.
 */
export class EvidenceImmutableError extends AppError {
  declare readonly code: 'CONFLICT';

  constructor(
    message = 'evidence object is write-once until its retention ends',
    options: AppErrorOptions = {},
  ) {
    super('CONFLICT', message, options);
  }
}
