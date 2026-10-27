// `pnpm db:seed` / `pnpm db:seed:reset` entry point (DEVENV-011). Dev and test only: production
// tenants are provisioned through onboarding, never seeded.

import pg from 'pg';

import { defineConfig } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { assertSeedAllowed, expandEnv, seedEnvSchema } from './env.js';
import { lookupSubjects } from './keycloak.js';
import { runSeed } from './run.js';
import { parseOnly } from './seeders.js';

const CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const log = createLogger('db-seed');
  const reset = process.argv.includes('--reset');
  assertSeedAllowed(process.env.NODE_ENV);
  // `--only=a,b` (the bare `--only` flag is refused as an empty list).
  const onlyArg = process.argv.find((arg) => arg === '--only' || arg.startsWith('--only='));
  const only = parseOnly(onlyArg === undefined ? undefined : onlyArg.slice('--only='.length));
  const env = defineConfig(seedEnvSchema, { source: expandEnv(process.env) });

  let subjects = {};
  if (
    env.BW_DEV_KEYCLOAK_ADMIN_USER !== undefined &&
    env.BW_DEV_KEYCLOAK_ADMIN_PASSWORD !== undefined
  ) {
    const lookup = await lookupSubjects({
      baseUrl: env.BW_DEV_KEYCLOAK_PUBLIC_URL,
      realm: env.BW_DEV_KEYCLOAK_REALM,
      adminUser: env.BW_DEV_KEYCLOAK_ADMIN_USER,
      adminPassword: env.BW_DEV_KEYCLOAK_ADMIN_PASSWORD,
    });
    subjects = lookup.subjects;
    if (lookup.missing.length > 0) {
      log.warn(
        { missing: lookup.missing, reason: lookup.unavailable ?? 'not in realm' },
        'Keycloak test users not confirmed; they keep a pending: subject (run pnpm dev:keycloak:check)',
      );
    }
  } else {
    log.warn({}, 'Keycloak admin credentials not set; seeded users keep a pending: subject');
  }

  const ownerPool = new pg.Pool({
    connectionString: env.MIGRATION_DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  const appPool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await runSeed({
      ownerPool,
      appPool,
      juiceShopUrl: env.BW_TARGET_JUICE_SHOP_URL,
      subjects,
      reset,
      ...(only === undefined ? {} : { only }),
      logger: log,
    });
  } finally {
    await Promise.all([ownerPool.end(), appPool.end()]);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    createLogger('db-seed').fatal({ err: error }, 'db:seed failed');
    process.exit(1);
  },
);
