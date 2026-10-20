import type { ProviderId } from './config.js';
import type { Logger } from '@blackwing/logger';

/** Audit events the gateway emits. Values are identifiers and statuses only, never request content. */
export type GatewayAuditEvent =
  | {
      readonly type: 'gateway.dev_provider.active';
      readonly provider: ProviderId;
    }
  | {
      readonly type: 'gateway.request';
      readonly provider: ProviderId;
      readonly status: number | 'client_closed';
      readonly traceId: string;
      readonly tenantId?: string | undefined;
      readonly keyId?: string | undefined;
    };

/** Where gateway audit events go. The append-only ledger writer (`@blackwing/audit`) plugs in here. */
export interface GatewayAuditSink {
  record(event: GatewayAuditEvent): void;
}

/** Writes each audit event as a structured `audit` log line, until the ledger writer is wired. */
export function loggerAuditSink(logger: Logger): GatewayAuditSink {
  return {
    record(event) {
      logger.info({ audit: event }, 'audit');
    },
  };
}
