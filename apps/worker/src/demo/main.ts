// DEMO-STORY runner process (`pnpm demo` starts it as the `demo-runner` service). Refuses to start unless
// BW_DEMO_MODE=1, so a production worker can never run the demo runner by accident. Dev only.
import pg from 'pg';
import { z } from 'zod';

import { defineConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { httpGet, pollOnce } from './runner.js';
import { pgRunnerStore } from './store-pg.js';

const POLL_INTERVAL_MS = 1000;
const STAGE_DELAY_MS = 900;

const runnerEnv = z.object({
  BW_DEMO_MODE: z.literal('1'),
  DATABASE_URL: z.string().min(1),
  DEMO_STAGE_DELAY_MS: z.coerce.number().int().min(0).default(STAGE_DELAY_MS),
});

const env = defineConfig(runnerEnv, {});
const logger = createLogger('demo-runner');
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 });
const store = pgRunnerStore(pool);
const deps = {
  fetch: httpGet,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  stageDelayMs: env.DEMO_STAGE_DELAY_MS,
};

let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      const took = await pollOnce(store, deps, logger);
      if (!took) await deps.sleep(POLL_INTERVAL_MS);
    } catch (error) {
      logger.error({ event: 'demo.runner.poll_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'poll failed');
      await deps.sleep(POLL_INTERVAL_MS);
    }
  }
}

function shutdown(): void {
  stopping = true;
  void pool.end().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
logger.info({ event: 'demo.runner.started' }, 'demo runner polling for queued runs');
void loop();
