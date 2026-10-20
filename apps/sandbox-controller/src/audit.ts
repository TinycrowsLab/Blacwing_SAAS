import type { Logger } from '@blackwing/logger';

export type ControllerAuditType = 'sandbox_controller.started' | 'sandbox_controller.stopped';

/** Lifecycle audit event. Carries a hash of the configuration, never its values (§8.7). */
export interface ControllerAuditEvent {
  readonly type: ControllerAuditType;
  readonly configHash: string;
  readonly version: string;
  readonly commit: string;
  readonly occurredAt: string;
  /** `stopped` only: the signal and whether the drain finished in time. */
  readonly signal?: string;
  readonly drained?: boolean;
}

export interface AuditEmitter {
  emit(event: ControllerAuditEvent): Promise<void>;
}

/**
 * Default emitter: one structured `audit` log line per event. The `@blackwing/audit` emitAudit helper
 * with its transactional outbox (#82) replaces it behind this interface.
 */
export function createLogAuditEmitter(logger: Logger): AuditEmitter {
  const log = logger.child({ component: 'audit' });
  return {
    emit(event) {
      log.info({ audit: event }, event.type);
      return Promise.resolve();
    },
  };
}
