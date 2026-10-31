import { metrics } from '@opentelemetry/api';

import type { StallObserver } from './stall-detector.js';
import type { Logger } from '@blackwing/logger';

/**
 * Default observer adapter (MENTOR-001, #420): OTel metrics and the `stall.detected` log line. Metric labels
 * are the bounded reason and severity sets only. The log carries the session id, reasons and severity, never
 * tool arguments or their digests.
 */
export function createOtelStallObserver(logger: Logger): StallObserver {
  const meter = metrics.getMeter('@blackwing/agents');
  const signals = meter.createCounter('stall_signals_total', {
    description: 'Stall signals raised by the mentor rules, by reason and severity',
  });
  const evalDuration = meter.createHistogram('stall_eval_duration_ms', {
    description: 'Time to evaluate the stall rules over one session window',
    unit: 'ms',
  });
  return {
    evaluated({ sessionId, signal, durationMs }) {
      evalDuration.record(durationMs);
      if (!signal.stalled) return;
      for (const reason of signal.reasons) {
        signals.add(1, { reason, severity: signal.severity });
      }
      logger.info(
        { sessionId, reasons: signal.reasons, severity: signal.severity },
        'stall.detected',
      );
    },
  };
}
