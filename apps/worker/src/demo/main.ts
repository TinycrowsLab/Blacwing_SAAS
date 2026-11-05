// AI hunt worker process (`pnpm demo` starts it as the `demo-runner` service). Refuses to start unless BW_DEMO_MODE=1,
// so a production worker can never run it by accident. Claims queued runs and hunts them, up to BW_HUNT_CONCURRENCY at once.
import pg from 'pg';
import { z } from 'zod';

import { defineConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { EventLog } from './hunt/context.js';
import { executeRun } from './hunt/orchestrator.js';
import { pgHuntStore } from './store-pg.js';

const MS_PER_S = 1000;
const POLL_INTERVAL_MS = MS_PER_S;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_GATE2_TIMEOUT_S = 300;
const POOL_CONNECTIONS_PER_RUN = 3;

const env = defineConfig(
  z.object({
    BW_DEMO_MODE: z.literal('1'),
    DATABASE_URL: z.string().min(1),
    BW_ENV: z.string().default('production'),
    BW_HUNT_MODEL: z.string().default('claude-sonnet-5-5'),
    BW_HUNT_CONCURRENCY: z.coerce.number().int().min(1).default(DEFAULT_CONCURRENCY),
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
  modelEnv: {
    HOME: env.HOME,
    PATH: env.PATH,
    ...(env.ANTHROPIC_API_KEY === undefined ? {} : { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }),
    ...(env.ANTHROPIC_BASE_URL === undefined ? {} : { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL }),
  },
  allowHostLogin: env.BW_ENV === 'dev',
};
const deps = { fetch, sleep, now: Date.now, gate2TimeoutMs: env.BW_GATE2_TIMEOUT_S * MS_PER_S };

let stopping = false;
const active = new Set<Promise<void>>();

/** A worker that died mid-run leaves it `running`: fail it so the console does not wait forever. */
async function recoverStaleRuns(): Promise<void> {
  for (const stale of await store.failStaleRuns()) {
    const log = new EventLog(store, stale.id, await store.nextSeq(stale.id), logger);
    await log.emit('run.failed', 'done', 'Run failed: the worker restarted', {
      requestsUsed: stale.requestsUsed,
      costUsd: stale.costUsd,
      findings: stale.findings,
      reason: 'worker_restarted',
    });
  }
}

async function loop(): Promise<void> {
  await recoverStaleRuns();
  while (!stopping) {
    try {
      const run = active.size < env.BW_HUNT_CONCURRENCY ? await store.claimQueuedRun() : null;
      if (run === null) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      const task = executeRun(store, run, deps, config, logger).finally(() => active.delete(task));
      active.add(task);
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
