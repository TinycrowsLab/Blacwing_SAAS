import { context, isSpanContextValid, trace } from '@opentelemetry/api';

/** Trace correlation fields written on a log line (OTel hex ids). */
export interface TraceFields {
  traceId?: string;
  spanId?: string;
}

/**
 * Reads the active span from the OpenTelemetry context. Returns `undefined` when there is no valid
 * active span, including before OpenTelemetry is initialised (the API's no-op context manager) and when
 * the registered context manager or span throws: logging must never fail because tracing did.
 */
export function activeTraceFields(): TraceFields | undefined {
  try {
    const span = trace.getSpan(context.active());
    if (span === undefined) return undefined;
    const spanContext = span.spanContext();
    if (!isSpanContextValid(spanContext)) return undefined;
    return { traceId: spanContext.traceId, spanId: spanContext.spanId };
  } catch {
    return undefined;
  }
}
