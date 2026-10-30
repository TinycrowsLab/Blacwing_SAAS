import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type ConnectionOptions,
  type Job,
  type JobsOptions,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
} from 'bullmq';
import { z } from 'zod';

import {
  QueuePayloadTooLargeError,
  QueueUnavailableError,
  ValidationError,
} from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { type BullConfig, parseBullConfig } from './config.js';
import { createOtelQueueMetrics, type QueueMetrics } from './metrics.js';

/** Logger and span component name (`component` field of every line, `bull.process` span scope). */
const COMPONENT = 'bullmq';
const TRACER_NAME = '@blackwing/queue';

/** Largest payload enqueued by default, measured as serialised UTF-8 JSON (`QUEUE_PAYLOAD_TOO_LARGE` above it). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262_144;
/** How long an enqueue waits on Valkey before it fails with `QUEUE_UNAVAILABLE`. */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;
/** Attempts before a job lands as failed. */
export const DEFAULT_JOB_ATTEMPTS = 5;
/** Base of the exponential retry delay, in milliseconds. */
export const DEFAULT_BACKOFF_DELAY_MS = 1_000;
/** Completed jobs are kept for an hour, so a late duplicate `jobId` is still dropped. */
const RETAIN_COMPLETED_SECONDS = 3_600;
const GAUGE_INTERVAL_MS = 15_000;
const RECONNECT_STEP_MS = 200;
const RECONNECT_CAP_MS = 5_000;
const DEFAULT_VALKEY_PORT = 6379;

const QUEUE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const JOB_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** Default job options (`attempts: 5`, exponential backoff from 1 s, `removeOnFail: false`). Returns a fresh object. */
export function defaultJobOptions(): JobsOptions {
  return {
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_DELAY_MS },
    removeOnComplete: { age: RETAIN_COMPLETED_SECONDS },
    removeOnFail: false,
  };
}

/**
 * BullMQ connection from a `redis:`/`rediss:` URL. `maxRetriesPerRequest` is `null`, as BullMQ requires for
 * workers, and reconnects back off linearly up to a 5 s cap. Credentials are read from the URL and never logged.
 */
export function getBullConnection(config: BullConfig = parseBullConfig()): ConnectionOptions {
  const url = new URL(config.redisUrl);
  const connection: ConnectionOptions = {
    host: url.hostname,
    port: url.port === '' ? DEFAULT_VALKEY_PORT : Number(url.port),
    maxRetriesPerRequest: null,
    retryStrategy: (attempt: number) => Math.min(attempt * RECONNECT_STEP_MS, RECONNECT_CAP_MS),
  };
  if (url.username !== '') connection.username = decodeURIComponent(url.username);
  if (url.password !== '') connection.password = decodeURIComponent(url.password);
  if (url.protocol === 'rediss:') connection.tls = {};
  return connection;
}

/** Options shared by {@link createQueue} and {@link createWorker}. */
export interface BullQueueOptions<T> {
  /**
   * Tenant that owns the queue. Its keys are `<BULL_PREFIX>:<tenantId>:<queue>:...`, so one tenant's
   * jobs can never be read or processed by another tenant's worker (CONTEXT_PACK §8.6). Required.
   */
  readonly tenantId: string;
  /** Zod schema of the payload: validated on enqueue and again before a worker runs the job. */
  readonly payload: z.ZodType<T>;
  /** Overrides the connection from `REDIS_URL` (tests, or a caller that already parsed its config). */
  readonly connection?: ConnectionOptions;
  /** Overrides `BULL_PREFIX`. */
  readonly prefix?: string;
}

/** Options of {@link createQueue}. */
export interface BullProducerOptions<T> extends BullQueueOptions<T> {
  /** Merged over the defaults of {@link defaultJobOptions}. */
  readonly jobOptions?: JobsOptions;
  /** Largest serialised payload accepted (default {@link DEFAULT_MAX_PAYLOAD_BYTES}). */
  readonly maxPayloadBytes?: number;
  /** Enqueue timeout before `QUEUE_UNAVAILABLE` (default {@link DEFAULT_ENQUEUE_TIMEOUT_MS}). */
  readonly enqueueTimeoutMs?: number;
}

/** Options of {@link createWorker}. */
export interface BullWorkerOptions<T> extends BullQueueOptions<T> {
  /** Jobs run at once (default `BULL_WORKER_CONCURRENCY`, 10). */
  readonly concurrency?: number;
  /** Metrics port (default: the OTel adapter). */
  readonly metrics?: QueueMetrics;
  /** Gauge sampling interval in milliseconds (default 15 s). */
  readonly gaugeIntervalMs?: number;
}

/** Typed producer for one tenant's queue. */
export interface BullQueue<T> {
  readonly name: string;
  /** The key root of this queue, `<BULL_PREFIX>:<tenantId>`. */
  readonly prefix: string;
  /**
   * Validates and enqueues one job. Fails with `VALIDATION_FAILED` on a bad payload or `jobId`,
   * `QUEUE_PAYLOAD_TOO_LARGE` over the size cap, and `QUEUE_UNAVAILABLE` when Valkey does not answer in
   * time (nothing is reported as enqueued in that case). A repeated `jobId` is a no-op, so callers can retry.
   */
  add(payload: T, options?: { readonly jobId?: string }): Promise<{ readonly jobId: string }>;
  /** Waiting plus delayed jobs. */
  depth(): Promise<number>;
  close(): Promise<void>;
}

/** What a processor learns about the job it runs. */
export interface BullJobContext {
  readonly queue: string;
  readonly jobId: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
}

/** A job processor. Throwing retries the job with backoff until its attempts run out. */
export type BullProcessor<T> = (payload: T, job: BullJobContext) => Promise<void>;

/** Typed worker for one tenant's queue. */
export interface BullWorker {
  readonly name: string;
  /** Stops taking jobs, waits for running ones, then closes the queue, events and worker connections. */
  close(): Promise<void>;
}

/** Resolves and checks the parts every factory needs: the queue name and tenant, the key root and the connection. */
function resolveScope<T>(
  name: string,
  options: BullQueueOptions<T>,
): { readonly prefix: string; readonly connection: ConnectionOptions } {
  if (!QUEUE_NAME.test(name)) {
    throw new ValidationError('queue name must be lowercase letters, digits or dashes (max 63)');
  }
  if (!z.uuid().safeParse(options.tenantId).success) {
    throw new ValidationError(
      'a queue needs a tenantId (uuid); refusing to create an unscoped queue',
    );
  }
  const config = parseBullConfig();
  const root = options.prefix ?? config.prefix;
  return {
    prefix: `${root}:${options.tenantId}`,
    connection: options.connection ?? getBullConnection(config),
  };
}

function withTimeout<R>(promise: Promise<R>, ms: number): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`queue operation timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => {
    clearTimeout(timer);
  });
}

/** Creates the typed producer for `name` in one tenant's key space. Does not start workers. */
export function createQueue<T>(name: string, options: BullProducerOptions<T>): BullQueue<T> {
  const scope = resolveScope(name, options);
  const maxBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const timeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;
  const log = createLogger(COMPONENT);
  const queue = new Queue(name, {
    connection: scope.connection,
    prefix: scope.prefix,
    defaultJobOptions: { ...defaultJobOptions(), ...options.jobOptions },
  });
  // Without a listener a Valkey error would crash the process; the enqueue path reports the failure itself.
  queue.on('error', (cause: Error) => {
    log.warn({ component: COMPONENT, queue: name, err: cause.message }, 'queue connection error');
  });

  return {
    name,
    prefix: scope.prefix,
    async add(payload, addOptions = {}) {
      const parsed = options.payload.safeParse(payload);
      if (!parsed.success) {
        throw new ValidationError(`payload for queue ${name} failed validation`);
      }
      const jobId = addOptions.jobId;
      if (jobId !== undefined && !JOB_ID.test(jobId)) {
        throw new ValidationError(
          'jobId must be 1-128 letters, digits, dots, dashes or underscores',
        );
      }
      const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
      if (bytes > maxBytes) {
        throw new QueuePayloadTooLargeError(
          `payload is ${bytes} bytes; the limit for queue ${name} is ${maxBytes}. Pass large data by reference.`,
        );
      }
      try {
        const job = await withTimeout(
          queue.add(name, parsed.data, jobId === undefined ? {} : { jobId }),
          timeoutMs,
        );
        if (job.id === undefined) throw new Error('BullMQ returned a job without an id');
        return { jobId: job.id };
      } catch (cause) {
        log.error(
          { component: COMPONENT, queue: name, err: errorMessage(cause) },
          'enqueue failed',
        );
        throw new QueueUnavailableError({ cause });
      }
    },
    async depth() {
      const counts = await queue.getJobCounts('waiting', 'delayed');
      return (counts.waiting ?? 0) + (counts.delayed ?? 0);
    },
    close: () => queue.close(),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown error';
}

/**
 * Starts a worker for `name` in one tenant's key space. The processor only sees payloads that pass the
 * schema: an invalid payload fails the job at once (`UnrecoverableError`, no retries). Completed and
 * failed jobs feed the metrics through a `QueueEvents` listener, and gauges are sampled on an interval.
 */
export function createWorker<T>(
  name: string,
  processor: BullProcessor<T>,
  options: BullWorkerOptions<T>,
): BullWorker {
  const scope = resolveScope(name, options);
  const config = parseBullConfig();
  const concurrency = options.concurrency ?? config.workerConcurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ValidationError('worker concurrency must be a positive integer');
  }
  const metrics = options.metrics ?? createOtelQueueMetrics();
  const log = createLogger(COMPONENT);
  const tracer = trace.getTracer(TRACER_NAME);

  const worker = new Worker(
    name,
    async (job: Job) => {
      const jobId = String(job.id);
      const attempt = job.attemptsMade + 1;
      const parsed = options.payload.safeParse(job.data);
      if (!parsed.success) {
        log.error(
          { component: COMPONENT, queue: name, jobId },
          'payload failed validation; not retried',
        );
        throw new UnrecoverableError(`payload for queue ${name} failed validation`);
      }
      return tracer.startActiveSpan(
        'bull.process',
        { attributes: { 'bull.queue': name, 'bull.job_id': jobId, 'bull.attempt': attempt } },
        async (span) => {
          try {
            await processor(parsed.data, { queue: name, jobId, attempt });
          } catch (cause) {
            span.recordException(cause instanceof Error ? cause : new Error(errorMessage(cause)));
            span.setStatus({ code: SpanStatusCode.ERROR });
            log.warn({ component: COMPONENT, queue: name, jobId, attempt }, 'job attempt failed');
            throw cause;
          } finally {
            span.end();
          }
        },
      );
    },
    // `autorun: false`: jobs start only once the QueueEvents listener below is subscribed, so no completion
    // or failure is missed from the metrics (see the start-up hook after the listener).
    { connection: scope.connection, prefix: scope.prefix, concurrency, autorun: false },
  );
  worker.on('error', (cause: Error) => {
    log.warn({ component: COMPONENT, queue: name, err: cause.message }, 'worker connection error');
  });

  const events = new QueueEvents(name, { connection: scope.connection, prefix: scope.prefix });
  events.on('error', (cause: Error) => {
    log.warn(
      { component: COMPONENT, queue: name, err: cause.message },
      'queue events connection error',
    );
  });
  events.on('completed', () => {
    metrics.completed(name);
  });
  events.on('failed', () => {
    metrics.failed(name);
  });
  let closing = false;
  events
    .waitUntilReady()
    .then(async () => {
      if (!closing) await worker.run();
    })
    .catch((cause: unknown) => {
      log.warn({ component: COMPONENT, queue: name, err: errorMessage(cause) }, 'worker stopped');
    });

  const sampler = new Queue(name, { connection: scope.connection, prefix: scope.prefix });
  sampler.on('error', () => undefined);
  const sample = async (): Promise<void> => {
    try {
      const counts = await sampler.getJobCounts('active', 'waiting', 'delayed');
      const waiting = counts.waiting ?? 0;
      const delayed = counts.delayed ?? 0;
      metrics.sampled(name, { active: counts.active ?? 0, waiting, depth: waiting + delayed });
    } catch (cause) {
      log.warn(
        { component: COMPONENT, queue: name, err: errorMessage(cause) },
        'gauge sampling failed',
      );
    }
  };
  const timer = setInterval(() => {
    void sample();
  }, options.gaugeIntervalMs ?? GAUGE_INTERVAL_MS);
  timer.unref();

  let closed: Promise<void> | undefined;
  return {
    name,
    close() {
      closed ??= (async () => {
        closing = true;
        clearInterval(timer);
        await worker.close();
        await events.close();
        await sampler.close();
      })();
      return closed;
    },
  };
}
