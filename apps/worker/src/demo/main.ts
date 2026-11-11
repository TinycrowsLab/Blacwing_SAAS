// AI hunt worker process (`pnpm demo` starts it as the `demo-runner` service). Refuses to start unless BW_DEMO_MODE=1,
// so a production worker can never run it by accident. Claims queued runs and hunts them, up to BW_HUNT_CONCURRENCY at once.
import pg from 'pg';
import { z } from 'zod';

import { defineConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { EventLog, newHuntState, type HuntContext } from './hunt/context.js';
import { sendRequest } from './hunt/http-tool.js';
import { executeRun } from './hunt/orchestrator.js';
import { retestFinding } from './hunt/validator.js';
import { pgHuntStore } from './store-pg.js';

import type { HuntStore, RetestJob, RetestResult } from './hunt/types.js';

const MS_PER_S = 1000;
const POLL_INTERVAL_MS = MS_PER_S;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_GATE2_TIMEOUT_S = 300;
const POOL_CONNECTIONS_PER_RUN = 3;

const env = defineConfig(
  z.object({
    BW_DEMO_MODE: z.literal('1'),
    DATABASE_URL: z.string().min(1),
    BW_ENV: z.string().default('production'),
    BW_HUNT_MODEL: z.string().min(1).default('claude-opus-5-5'),
    /** Used when the primary model is overloaded or unavailable (Agent SDK `fallbackModel`). Empty disables it. */
    BW_HUNT_FALLBACK_MODEL: z.string().default('claude-opus-5'),
    /** Agent SDK `effort` for the orchestrator and every subagent. */
    BW_HUNT_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    /** Report-writing model call only (the executive summary; the rest of the report is built deterministically from data). */
    BW_REPORT_MODEL: z.string().min(1).default('claude-sonnet-5'),
    BW_REPORT_FALLBACK_MODEL: z.string().default('claude-opus-5'),
    /** `off` skips the AI-written executive summary; reports then omit that section. */
    BW_REPORT_SUMMARY: z.enum(['on', 'off']).default('on'),
    /** Threat intel keys (all optional; a source without its key is skipped and the run says so). */
    BW_GITHUB_TOKEN: z.string().min(1).optional(),
    BW_HIBP_API_KEY: z.string().min(1).optional(),
    BW_INTEL_ENABLED: z.enum(['0', '1']).default('1'),
    BW_HUNT_CONCURRENCY: z.coerce.number().int().min(1).default(DEFAULT_CONCURRENCY),
    BW_DEMO_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
    BW_CONSOLE_ORIGIN: z.string().min(1).default('http://localhost:3000'),
    BW_GATE2_TIMEOUT_S: z.coerce.number().int().min(1).default(DEFAULT_GATE2_TIMEOUT_S),
    HOME: z.string().min(1),
    PATH: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_BASE_URL: z.string().min(1).optional(),
  }),
);
const logger = createLogger('demo-runner');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: env.BW_HUNT_CONCURRENCY * POOL_CONNECTIONS_PER_RUN });
const store = pgHuntStore(pool);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// OFFLINE-STUB(online-porting): direct SDK auth instead of the model gateway. Only the host login of a dev machine
// may stand in for an API key; any other environment without ANTHROPIC_API_KEY fails the run.
const config = {
  model: env.BW_HUNT_MODEL,
  fallbackModel: env.BW_HUNT_FALLBACK_MODEL.trim() === '' ? null : env.BW_HUNT_FALLBACK_MODEL.trim(),
  effort: env.BW_HUNT_EFFORT,
  report: {
    model: env.BW_REPORT_MODEL,
    fallbackModel: env.BW_REPORT_FALLBACK_MODEL.trim() === '' ? null : env.BW_REPORT_FALLBACK_MODEL.trim(),
    effort: 'medium' as const,
    summary: env.BW_REPORT_SUMMARY === 'on',
  },
  intel: env.BW_INTEL_ENABLED === '1' ? { githubToken: env.BW_GITHUB_TOKEN ?? null, hibpApiKey: env.BW_HIBP_API_KEY ?? null } : null,
  modelEnv: {
    HOME: env.HOME,
    PATH: env.PATH,
    ...(env.ANTHROPIC_API_KEY === undefined ? {} : { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }),
    ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL }),
  },
  allowHostLogin: env.BW_ENV === 'dev',
};
const deps = {
  fetch,
  sleep,
  now: Date.now,
  gate2TimeoutMs: env.BW_GATE2_TIMEOUT_S * MS_PER_S,
  webhookUrl: env.BW_DEMO_WEBHOOK_URL ?? null,
  consoleOrigin: env.BW_CONSOLE_ORIGIN,
};

let stopping = false;
const active = new Set<Promise<void>>();

/** A worker that died mid-run leaves it `running`: fail it so the console does not wait forever. */
async function recoverStaleRuns(): Promise<void> {
  for (const stale of await store.failStaleRuns()) {
    const log = new EventLog(store, stale.id, logger);
    await log.emit('run.failed', 'done', 'Run failed: the worker restarted', {
      requestsUsed: stale.requestsUsed,
      costUsd: stale.costUsd,
      findings: stale.findings,
      reason: 'worker_restarted',
    });
  }
}

/**
 * A retest replays one stored finding (probe replays + control, no Gate 2) under its run's pinned scope, lab origins
 * and the request's test accounts. It adds nothing to the finished run's timeline; the result goes on the retest row.
 */
async function executeRetest(job: RetestJob): Promise<void> {
  const quiet: HuntStore = { ...store, appendEvent: () => Promise.resolve(), insertExchange: () => Promise.resolve() };
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, job.run.budgetSeconds * MS_PER_S);
  const ctx: HuntContext = { run: job.run, store: quiet, log: new EventLog(quiet, job.run.id, logger), signal: abort.signal, deps, state: newHuntState() };
  let result: RetestResult;
  try {
    result = await retestFinding(job, (request) => sendRequest(ctx, 'validator', request, { purpose: 'retest a finding', askGate2: false }));
  } catch (error) {
    logger.error({ event: 'demo.runner.retest_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'retest failed');
    result = { status: 'failed', result: null, detail: { reason: 'The retest could not finish.' } };
  } finally {
    clearTimeout(timer);
  }
  await store.finishRetest(job.id, result);
}

function track(task: Promise<void>): void {
  const tracked = task.finally(() => {
    active.delete(tracked);
  });
  active.add(tracked);
}

async function loop(): Promise<void> {
  await recoverStaleRuns();
  while (!stopping) {
    try {
      // Audits first; a free slot with no queued audit takes a queued retest.
      const free = active.size < env.BW_HUNT_CONCURRENCY;
      const run = free ? await store.claimQueuedRun() : null;
      const retest = free && run === null ? await store.claimQueuedRetest() : null;
      if (run !== null) track(executeRun(store, run, deps, config, logger));
      else if (retest !== null) track(executeRetest(retest));
      else await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      logger.error({ event: 'demo.runner.poll_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'poll failed');
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function shutdown(): void {
  stopping = true;
  void pool.end().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
logger.info({ event: 'demo.runner.started' }, 'hunt worker polling for queued runs');
void loop();
