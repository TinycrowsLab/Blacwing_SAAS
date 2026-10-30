import './instrument.js';

import { createLogger } from '@blackwing/logger';

import { startWorkerProcess } from './bootstrap.js';

const log = createLogger('worker').child({ component: 'temporal-worker' });

/** Process entry: start, wait for the workers, drain on SIGTERM/SIGINT. Exits non-zero on any failure. */
async function main(): Promise<void> {
  const worker = await startWorkerProcess();
  const stop = (signal: NodeJS.Signals): void => {
    worker.shutdown(signal).catch((err: unknown) => {
      log.fatal({ err }, 'graceful shutdown failed');
      process.exit(1);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await worker.runtime.run();
  // run() resolves only after shutdown() has drained the workers; let it finish closing connections.
  await worker.shutdown('workers stopped');
}

main().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    log.fatal({ err }, 'worker process failed to start or crashed');
    process.exit(1);
  },
);
