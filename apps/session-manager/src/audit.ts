import { redactLogValue } from './redaction.js';

import type { Logger } from '@blackwing/logger';

export type SessionManagerAuditType = 'session_manager.started' | 'session_manager.stopped';

/** Lifecycle audit event. Carries a hash of the configuration, never its values (S8.7). */
export interface SessionManagerAuditEvent {
  readonly type: SessionManagerAuditType;
  readonly configHash: string;
  readonly version: string;
  readonly commit: string;
  readonly occurredAt: string;
  /** `stopped` only: the signal and whether the drain finished in time. */
  readonly signal?: string;
  readonly drained?: boolean;
}

export interface AuditEmitter {
  emit(event: SessionManagerAuditEvent): Promise<void>;
}

/**
 * Default emitter: one structured `audit` log line per event, passed through the redaction serializer. The
 * `@blackwing/audit` emitAudit helper with its transactional outbox replaces it behind this interface.
 */
export function createLogAuditEmitter(logger: Logger): AuditEmitter {
  const log = logger.child({ component: 'audit' });
  return {
    emit(event) {
      log.info({ audit: redactLogValue(event) }, event.type);
      return Promise.resolve();
    },
  };
}
