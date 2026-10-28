import { z } from 'zod';

import { baseEnvSchema, loadConfig, zDurationMs, zPort, type EnvSource } from '@blackwing/config';

import { parseTaskQueues, type TaskQueueName } from './task-queues.js';

const DEFAULT_MAX_ACTIVITY_CONCURRENCY = 20;
const DEFAULT_MAX_WORKFLOW_CONCURRENCY = 40;
const DEFAULT_HEALTH_PORT = 13800;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_KILL_CHAOS_RUNS = 25;
const MAX_KILL_CHAOS_RUNS = 500;

/** Positive integer from a string env value. Zero, signs, fractions and blanks are rejected. */
export const positiveInt = z
  .string()
  .regex(/^[1-9][0-9]{0,5}$/, 'must be a positive integer')
  .transform(Number);

/**
 * `AUDIT_ACTIVITY_SAMPLE`: comma-separated `activityType=rate` pairs, rate in (0, 1]. Only the listed
 * types are sampled; every other activity is audited in full (fail closed). Gate/kill/state-changing
 * types are never sampled, whatever is listed here (enforced by the audit interceptor).
 */
const sampleRates = z
  .string()
  .default('')
  .transform((value, ctx) => {
    const rates = new Map<string, number>();
    for (const pair of value.split(',').filter((part) => part.trim() !== '')) {
      const [type = '', rate = '', ...extra] = pair.split('=').map((part) => part.trim());
      const parsed = Number(rate);
      if (extra.length > 0 || type === '' || rate === '' || !(parsed > 0 && parsed <= 1)) {
        ctx.addIssue({
          code: 'custom',
          message: 'must be activityType=rate pairs with rate in (0, 1]',
        });
        return z.NEVER;
      }
      rates.set(type, parsed);
    }
    return rates;
  });

const workerEnvSchema = baseEnvSchema.extend({
  TEMPORAL_MAX_ACTIVITY_CONCURRENCY: positiveInt.default(DEFAULT_MAX_ACTIVITY_CONCURRENCY),
  TEMPORAL_MAX_WORKFLOW_CONCURRENCY: positiveInt.default(DEFAULT_MAX_WORKFLOW_CONCURRENCY),
  WORKER_TASK_QUEUES: z.string().optional(),
  WORKER_HEALTH_PORT: zPort().default(DEFAULT_HEALTH_PORT),
  WORKER_SHUTDOWN_GRACE: zDurationMs().default(DEFAULT_SHUTDOWN_GRACE_MS),
  AUDIT_ACTIVITY_SAMPLE: sampleRates,
});

/** Validated worker process settings. */
export interface WorkerConfig {
  readonly maxConcurrentActivityTaskExecutions: number;
  readonly maxConcurrentWorkflowTaskExecutions: number;
  readonly taskQueues: readonly TaskQueueName[];
  readonly healthPort: number;
  /** How long `worker.shutdown()` lets in-flight tasks drain before the SDK forces them. */
  readonly shutdownGraceMs: number;
  /** Per activity type sampling rate for its started/succeeded audit events (see `sampleRates`). */
  readonly auditActivitySample: ReadonlyMap<string, number>;
}

/** Parses the worker environment. Throws on invalid values and `WORKER_QUEUE_UNKNOWN` on a bad queue. */
export function parseWorkerConfig(source: EnvSource = process.env): WorkerConfig {
  const env = loadConfig(workerEnvSchema, source);
  return {
    maxConcurrentActivityTaskExecutions: env.TEMPORAL_MAX_ACTIVITY_CONCURRENCY,
    maxConcurrentWorkflowTaskExecutions: env.TEMPORAL_MAX_WORKFLOW_CONCURRENCY,
    taskQueues: parseTaskQueues(env.WORKER_TASK_QUEUES),
    healthPort: env.WORKER_HEALTH_PORT,
    shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE,
    auditActivitySample: env.AUDIT_ACTIVITY_SAMPLE,
  };
}

/** Settings for the kill chaos/SLO suite (KILL-008). Only the nightly and on-demand chaos job reads them. */
export interface KillChaosConfig {
  /** Non-terminal runs seeded for the load scenario (`KILL_CHAOS_RUNS`, default 25). */
  readonly runs: number;
  /** `mock` drives an in-process control plane; `real` targets the live stack (see `docs/runbooks/kill-slo.md`). */
  readonly mode: 'mock' | 'real';
  /** Live control-plane base URLs, required in `real` mode. */
  readonly egressUrl: string | undefined;
  readonly sandboxUrl: string | undefined;
  readonly keysUrl: string | undefined;
  /** Where the JSON SLO report is written; unset means `eval/harness/out/kill-slo-report.json`. */
  readonly reportPath: string | undefined;
}

const killChaosEnvSchema = z
  .object({
    KILL_CHAOS_RUNS: positiveInt
      .pipe(z.number().max(MAX_KILL_CHAOS_RUNS))
      .default(DEFAULT_KILL_CHAOS_RUNS),
    KILL_CHAOS_MODE: z.enum(['mock', 'real']).default('mock'),
    KILL_CHAOS_EGRESS_URL: z.url().optional(),
    KILL_CHAOS_SANDBOX_URL: z.url().optional(),
    KILL_CHAOS_KEYS_URL: z.url().optional(),
    KILL_CHAOS_REPORT_PATH: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.KILL_CHAOS_MODE !== 'real') return;
    for (const key of [
      'KILL_CHAOS_EGRESS_URL',
      'KILL_CHAOS_SANDBOX_URL',
      'KILL_CHAOS_KEYS_URL',
    ] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when KILL_CHAOS_MODE=real',
        });
      }
    }
  });

/** Parses the kill chaos settings. Throws on invalid values, and in `real` mode without every control URL. */
export function parseKillChaosConfig(source: EnvSource = process.env): KillChaosConfig {
  const env = loadConfig(killChaosEnvSchema, source);
  return {
    runs: env.KILL_CHAOS_RUNS,
    mode: env.KILL_CHAOS_MODE,
    egressUrl: env.KILL_CHAOS_EGRESS_URL,
    sandboxUrl: env.KILL_CHAOS_SANDBOX_URL,
    keysUrl: env.KILL_CHAOS_KEYS_URL,
    reportPath: env.KILL_CHAOS_REPORT_PATH,
  };
}
