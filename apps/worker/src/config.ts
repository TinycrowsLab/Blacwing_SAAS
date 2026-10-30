import { isIP } from 'node:net';

import { z } from 'zod';

import { baseEnvSchema, loadConfig, zDurationMs, zPort, type EnvSource } from '@blackwing/config';
import { DNS_TXT_DEFAULTS } from '@blackwing/domain';

import { parseTaskQueues, type TaskQueueName } from './task-queues.js';

const DEFAULT_MAX_ACTIVITY_CONCURRENCY = 20;
const DEFAULT_MAX_WORKFLOW_CONCURRENCY = 40;
const DEFAULT_HEALTH_PORT = 13800;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_KILL_CHAOS_RUNS = 25;
const DEFAULT_AUDIT_EXPORT_BATCH = 500;
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

/** Trusted DNS upstreams of the TXT ownership probe (`ip` or `ip:port`, IPv4 with a port). */
const dnsResolvers = z
  .string()
  .default('1.1.1.1,9.9.9.9')
  .transform((value, ctx) => {
    const servers = value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const valid = servers.every(
      (server) => isIP(server) !== 0 || /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(server),
    );
    if (servers.length === 0 || !valid) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a comma list of IP addresses, optionally with a port (ip:port)',
      });
      return z.NEVER;
    }
    return servers;
  });

/** Non-negative integer from a string env value (zero is a valid retry count). */
const nonNegativeInt = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,2})$/, 'must be a non-negative integer')
  .transform(Number);

const workerEnvSchema = baseEnvSchema.extend({
  TEMPORAL_MAX_ACTIVITY_CONCURRENCY: positiveInt.default(DEFAULT_MAX_ACTIVITY_CONCURRENCY),
  TEMPORAL_MAX_WORKFLOW_CONCURRENCY: positiveInt.default(DEFAULT_MAX_WORKFLOW_CONCURRENCY),
  WORKER_TASK_QUEUES: z.string().optional(),
  WORKER_HEALTH_PORT: zPort().default(DEFAULT_HEALTH_PORT),
  WORKER_SHUTDOWN_GRACE: zDurationMs().default(DEFAULT_SHUTDOWN_GRACE_MS),
  AUDIT_ACTIVITY_SAMPLE: sampleRates,
  /** `bw.asset.dns.*`: the pinned resolver set and the probe bounds of the DNS TXT ownership probe. */
  /** `AUDIT_EXPORT_BATCH`: ledger events read per SIEM export call (AUDIT-004). Chunked to each connector's limit. */
  AUDIT_EXPORT_BATCH: positiveInt.default(DEFAULT_AUDIT_EXPORT_BATCH),
  ASSET_DNS_RESOLVERS: dnsResolvers,
  ASSET_DNS_TIMEOUT_MS: positiveInt.default(DNS_TXT_DEFAULTS.timeoutMs),
  ASSET_DNS_RETRIES: nonNegativeInt.default(DNS_TXT_DEFAULTS.retries),
  ASSET_DNS_MAX_RECORDS: positiveInt.default(DNS_TXT_DEFAULTS.maxRecords),
});

/** Settings for the DNS TXT ownership probe (ASSET-005). */
export interface DnsVerificationConfig {
  /** Trusted upstreams the probe queries (`ASSET_DNS_RESOLVERS`). Nothing else is ever queried. */
  readonly resolvers: readonly string[];
  readonly timeoutMs: number;
  readonly retries: number;
  readonly maxRecords: number;
}

/** Settings for the SIEM export dispatcher (AUDIT-004). */
export interface AuditExportConfig {
  /** Events read per export call (`AUDIT_EXPORT_BATCH`, default 500). */
  readonly batchSize: number;
}

/** Parses the SIEM export settings. Throws on a non-positive or non-integer batch size. */
export function parseAuditExportConfig(source: EnvSource = process.env): AuditExportConfig {
  const env = loadConfig(workerEnvSchema, source);
  return { batchSize: env.AUDIT_EXPORT_BATCH };
}

/** Parses the DNS probe settings. Throws on an invalid resolver address or bound. */
export function parseDnsVerificationConfig(source: EnvSource = process.env): DnsVerificationConfig {
  const env = loadConfig(workerEnvSchema, source);
  return {
    resolvers: env.ASSET_DNS_RESOLVERS,
    timeoutMs: env.ASSET_DNS_TIMEOUT_MS,
    retries: env.ASSET_DNS_RETRIES,
    maxRecords: env.ASSET_DNS_MAX_RECORDS,
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
