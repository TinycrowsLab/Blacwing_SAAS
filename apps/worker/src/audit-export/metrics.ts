import { metrics, trace } from '@opentelemetry/api';

import type { AuditExportMetrics, AuditSpanRunner } from '@blackwing/audit';

const METER = '@blackwing/worker';

/**
 * The SIEM export metrics (AUDIT-004): `audit_export_delivered_total{kind}`, `audit_export_failed_total{kind}`,
 * `audit_export_backlog{subscription}` and `audit_export_cursor_seq{subscription}`. Labels hold a destination kind or
 * a subscription id only, never a credential, an address or an event payload.
 */
export function createOtelAuditExportMetrics(): AuditExportMetrics {
  const meter = metrics.getMeter(METER);
  const delivered = meter.createCounter('audit_export_delivered_total', {
    description: 'Audit events confirmed by a SIEM destination, by destination kind',
  });
  const failed = meter.createCounter('audit_export_failed_total', {
    description:
      'SIEM export deliveries that failed (the cursor did not move), by destination kind',
  });
  const backlog = meter.createGauge('audit_export_backlog', {
    description: 'Ledger events not yet confirmed by a subscription (head seq minus cursor)',
  });
  const cursor = meter.createGauge('audit_export_cursor_seq', {
    description: 'Highest ledger seq a subscription has confirmed',
  });
  return {
    delivered: ({ kind }, count) => {
      if (count > 0) delivered.add(count, { kind });
    },
    failed: ({ kind }) => {
      failed.add(1, { kind });
    },
    backlog: ({ subscription }, value) => {
      backlog.record(value, { subscription });
    },
    cursor: ({ subscription }, value) => {
      cursor.record(value, { subscription });
    },
  };
}

/** The trace span of one export call (`audit.export.deliver`). */
export const auditExportSpan: AuditSpanRunner = (name, fn) =>
  trace.getTracer(METER).startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
