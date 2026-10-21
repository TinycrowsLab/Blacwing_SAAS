// `pnpm db:migrate` (and the deploy `migrate` job) entry point (DB-002). Connects as the owner role
// from PG_* / PG_OWNER_* (in deploys the owner credentials come from the secret store, never from
// the repo), applies pending migrations and exits non-zero on any failure. `--down` reverts the
// latest migration with its dev-only down file and is refused in production without the flag.

import { z } from 'zod';

import { defineConfig, NODE_ENVS } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { migrateDatabase, rollbackLatestMigration } from './migrate.js';
import { createOwnerPool } from './owner.js';
import { expandEnv } from './seed/env.js';

const guardEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  ALLOW_DESTRUCTIVE_MIGRATION: z.enum(['0', '1']).optional(),
});

async function main(): Promise<void> {
  const logger = createLogger('db-migrate');
  const source = expandEnv(process.env);
  const env = defineConfig(guardEnvSchema, { source });
  const pool = createOwnerPool({ logger, source });
  const client = await pool.connect();
  try {
    if (process.argv.includes('--down')) {
      await rollbackLatestMigration(client, logger, { env });
    } else {
      await migrateDatabase(client, logger, { env });
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    createLogger('db-migrate').fatal({ err: error }, 'db.migrate.failed');
    process.exit(1);
  },
);
