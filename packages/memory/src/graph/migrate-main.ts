// `pnpm graph:migrate` and `pnpm graph:migrate:check` entry point (GRAPH-002). Applies pending surface-graph
// migrations. With `--check` it only reports them, and exits non-zero unless the ledger matches the files (the CI
// gate). Exits non-zero on any failure, and logs only error names and codes (never messages, which can name hosts).

import { AppError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';

import { closeDriver } from './driver.js';
import {
  checkGraphMigrations,
  isGraphMigrationReportClean,
  runGraphMigrations,
} from './migrate.js';

const logger = createLogger('graph-migrate');

async function main(): Promise<number> {
  try {
    if (process.argv.includes('--check')) {
      const status = await checkGraphMigrations();
      logger.info({ ...status }, 'graph.migration.check');
      return isGraphMigrationReportClean(status) ? 0 : 1;
    }
    const applied = await runGraphMigrations();
    logger.info({ applied }, 'graph.migration.run.done');
    return 0;
  } finally {
    await closeDriver();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    logger.fatal(
      {
        error_name: error instanceof Error ? error.name : 'unknown',
        error_code: error instanceof AppError ? error.code : undefined,
      },
      'graph.migration.fatal',
    );
    process.exit(1);
  },
);
