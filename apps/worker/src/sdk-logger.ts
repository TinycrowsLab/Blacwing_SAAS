import { metrics } from '@opentelemetry/api';

import type { Logger } from '@blackwing/logger';
import type { LogLevel, LogMetadata, Logger as SdkLogger } from '@temporalio/worker';

const pollErrors = metrics
  .getMeter('@blackwing/worker')
  .createCounter('temporal_worker_poll_errors_total', {
    description: 'Temporal task poll failures the SDK recovered from by reconnecting',
  });

const POLL_ERROR = /poll/i;

/**
 * Routes the Temporal SDK's own log output through the structured logger and counts poll failures.
 * The SDK retries polls itself (connection loss never crashes the worker); counting them here is what
 * makes a flapping connection visible.
 */
export function createSdkLogger(log: Logger): SdkLogger {
  const sdk = log.child({ component: 'temporal-sdk' });
  const emit = (level: LogLevel, message: string, meta?: LogMetadata): void => {
    if ((level === 'WARN' || level === 'ERROR') && POLL_ERROR.test(message)) pollErrors.add(1);
    const fields = meta === undefined ? {} : { sdk: meta };
    switch (level) {
      case 'TRACE':
      case 'DEBUG':
        sdk.debug(fields, message);
        break;
      case 'INFO':
        sdk.info(fields, message);
        break;
      case 'WARN':
        sdk.warn(fields, message);
        break;
      case 'ERROR':
        sdk.error(fields, message);
        break;
    }
  };
  return {
    log: emit,
    trace: (message, meta) => {
      emit('TRACE', message, meta);
    },
    debug: (message, meta) => {
      emit('DEBUG', message, meta);
    },
    info: (message, meta) => {
      emit('INFO', message, meta);
    },
    warn: (message, meta) => {
      emit('WARN', message, meta);
    },
    error: (message, meta) => {
      emit('ERROR', message, meta);
    },
  };
}
