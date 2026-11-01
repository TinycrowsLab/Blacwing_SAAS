import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { bundleWorkflowCode, NativeConnection, Runtime, Worker } from '@temporalio/worker';

import { parseTemporalConfig, type EnvSource, type TemporalConfig } from '@blackwing/config';
import { getDb } from '@blackwing/db';
import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';
import { closeTemporal, createDataConverter, getTemporalClient } from '@blackwing/workflow-shared';

import { activities } from './activities/index.js';
import { parseWorkerConfig } from './config.js';
import { createHealthServer } from './health.js';
import { createContextWorkerOptions, WORKFLOW_INTERCEPTOR_MODULE } from './interceptors/context.js';
import { WorkerRuntime } from './runtime.js';
import { createScheduleSync } from './schedules/sync.js';
import { createSdkLogger } from './sdk-logger.js';
import { TASK_QUEUES } from './task-queues.js';

import type { FastifyInstance } from 'fastify';

/** Entry module of the workflow bundle (the deterministic sandbox graph). */
const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

const log = createLogger('worker');
const tracer = trace.getTracer('@blackwing/worker');

/** A started worker process: the worker runtime plus its health server. */
export interface WorkerProcess {
  readonly runtime: WorkerRuntime;
  readonly health: FastifyInstance;
  /** Drains in-flight work, closes connections and the health server. */
  shutdown(reason: string): Promise<void>;
}

async function nativeConnect(config: TemporalConfig): Promise<NativeConnection> {
  if (!config.tls.enabled) return NativeConnection.connect({ address: config.address });
  const { clientCertPath, clientKeyPath } = config.tls;
  if (clientCertPath === undefined || clientKeyPath === undefined) {
    throw new AppError(
      'TEMPORAL_TLS_MISCONFIGURED',
      'TEMPORAL_TLS_ENABLED=true requires TEMPORAL_CLIENT_CERT_PATH and TEMPORAL_CLIENT_KEY_PATH',
    );
  }
  let crt: Buffer;
  let key: Buffer;
  try {
    [crt, key] = await Promise.all([readFile(clientCertPath), readFile(clientKeyPath)]);
  } catch (cause) {
    // Contents and paths are never logged.
    throw new AppError(
      'TEMPORAL_TLS_MISCONFIGURED',
      'Temporal client certificate or key could not be read',
      { cause },
    );
  }
  return NativeConnection.connect({
    address: config.address,
    tls: { clientCertPair: { crt, key } },
  });
}

/**
 * Boots the worker process: validates config, builds the workflow bundle, connects, starts one worker per
 * selected task queue and the health server. Any failure throws (the caller exits non-zero); a bundle
 * build failure is never papered over with a stale bundle.
 */
export async function startWorkerProcess(env: EnvSource = process.env): Promise<WorkerProcess> {
  return tracer.startActiveSpan('worker.bootstrap', async (span) => {
    try {
      const config = parseWorkerConfig(env);
      const temporal = parseTemporalConfig(env);

      Runtime.install({ logger: createSdkLogger(log) });
      // Built once per start, in memory: there is no cached bundle that could go stale.
      const { code } = await bundleWorkflowCode({
        workflowsPath: WORKFLOWS_PATH,
        // Tenant and trace propagation (#25, §8.6) runs inside every workflow.
        workflowInterceptorModules: [WORKFLOW_INTERCEPTOR_MODULE],
      });
      const connection = await nativeConnect(temporal);
      const dataConverter = createDataConverter();
      const contextOptions = createContextWorkerOptions(log);
      // Schedules are reconciled only where the `scheduler` queue is served (SCHED-003); the activity is still registered.
      const schedules = config.taskQueues.includes(TASK_QUEUES.SCHEDULER)
        ? createScheduleSync({
            db: getDb(),
            temporal: await getTemporalClient({ config: temporal, dataConverter }),
            log,
          })
        : undefined;
      const workerActivities = { ...activities, ...schedules?.activities };

      const runtime = new WorkerRuntime({
        config,
        log,
        createWorker: (taskQueue) =>
          Worker.create({
            connection,
            namespace: temporal.namespace,
            taskQueue,
            workflowBundle: { code },
            activities: workerActivities,
            dataConverter,
            maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
            maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
            shutdownGraceTime: config.shutdownGraceMs,
            interceptors: contextOptions.interceptors,
            sinks: contextOptions.sinks,
          }),
        closeConnections: async () => {
          await connection.close();
          await closeTemporal();
        },
      });
      const health = createHealthServer(() => runtime.health());

      await runtime.start();
      const reconciler = schedules?.startReconciler();
      await health.listen({ port: config.healthPort, host: '0.0.0.0' });
      log.info(
        {
          component: 'temporal-worker',
          namespace: temporal.namespace,
          taskQueues: config.taskQueues,
        },
        'worker process started',
      );

      return {
        runtime,
        health,
        shutdown: async (reason: string) => {
          reconciler?.stop();
          await runtime.shutdown(reason);
          await health.close();
        },
      };
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
