import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import { DropOldestExportQueue, type ExportQueueOptions } from './export-queue.js';

import type {
  LogRecordExporter,
  LogRecordProcessor,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import type { ReadableSpan, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/** Export queue settings shared by the trace and log pipelines (OBS-001: bounded memory, backoff retries). */
const EXPORT_QUEUE_DEFAULTS = {
  maxQueueSize: 2048,
  maxBatchSize: 512,
  scheduledDelayMs: 1000,
  baseBackoffMs: 1000,
  maxBackoffMs: 30000,
} as const;

/** Maps an OpenTelemetry export result onto the queue's success flag. */
export function isExportSuccess(result: ExportResult): boolean {
  return result.code === ExportResultCode.SUCCESS;
}

/** Span processor that buffers ended spans in a bounded queue and sends them through `exporter`. */
export class QueuedSpanProcessor implements SpanProcessor {
  private readonly queue: DropOldestExportQueue<ReadableSpan>;

  constructor(
    private readonly exporter: SpanExporter,
    options: Pick<ExportQueueOptions<ReadableSpan>, 'onDropped' | 'onExportError'>,
  ) {
    this.queue = new DropOldestExportQueue<ReadableSpan>({
      ...EXPORT_QUEUE_DEFAULTS,
      ...options,
      exportBatch: (batch, done) => {
        exporter.export(batch, (result) => {
          done(isExportSuccess(result));
        });
      },
    });
    this.queue.start();
  }

  onStart(): void {
    // Spans are buffered when they end, so nothing happens at start.
  }

  onEnd(span: ReadableSpan): void {
    this.queue.enqueue(span);
  }

  forceFlush(): Promise<void> {
    return this.queue.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.queue.shutdown();
    await this.exporter.shutdown();
  }
}

/** Log record processor with the same bounded, retrying queue as {@link QueuedSpanProcessor}. */
export class QueuedLogRecordProcessor implements LogRecordProcessor {
  private readonly queue: DropOldestExportQueue<ReadableLogRecord>;

  constructor(
    private readonly exporter: LogRecordExporter,
    options: Pick<ExportQueueOptions<ReadableLogRecord>, 'onDropped' | 'onExportError'>,
  ) {
    this.queue = new DropOldestExportQueue<ReadableLogRecord>({
      ...EXPORT_QUEUE_DEFAULTS,
      ...options,
      exportBatch: (batch, done) => {
        exporter.export(batch, (result) => {
          done(isExportSuccess(result));
        });
      },
    });
    this.queue.start();
  }

  onEmit(logRecord: ReadableLogRecord): void {
    this.queue.enqueue(logRecord);
  }

  forceFlush(): Promise<void> {
    return this.queue.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.queue.shutdown();
    await this.exporter.shutdown();
  }
}
