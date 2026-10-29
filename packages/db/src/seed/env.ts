// Environment of `pnpm db:seed` (DEVENV-011), parsed through @blackwing/config.

import { z } from 'zod';

import { type EnvSource, zSecret, zSecretUrl, zString, zUrl } from '@blackwing/config';
import { AppError } from '@blackwing/errors';

/** Expands `${NAME}` references the way `.env.example` writes them (dotenv files loaded by Node do not). */
export function expandEnv(source: EnvSource): EnvSource {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value?.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => source[name] ?? '');
  }
  return out;
}

export const seedEnvSchema = z.object({
  /** Seeding is refused outside development/test. */
  NODE_ENV: z.enum(['development', 'test']),
  DATABASE_URL: zSecretUrl({ protocols: ['postgres:', 'postgresql:'] }),
  MIGRATION_DATABASE_URL: zSecretUrl({ protocols: ['postgres:', 'postgresql:'] }),
  BW_TARGET_JUICE_SHOP_URL: zUrl({ protocols: ['http:', 'https:'] }).default(
    'http://127.0.0.1:13000',
  ),
  /**
   * The address the egress gateway targets (#880): the compose service name on the lab network. It must
   * never be `localhost`; the seeded private-range rule is refused otherwise.
   */
  BW_TARGET_JUICE_SHOP_GATEWAY_URL: zUrl({ protocols: ['http:', 'https:'] }).default(
    'http://juice-shop:3000',
  ),
  BW_DEV_KEYCLOAK_PUBLIC_URL: zUrl({ protocols: ['http:', 'https:'] }).default(
    'http://localhost:18080',
  ),
  BW_DEV_KEYCLOAK_REALM: zString({ trim: true }).default('blackwing-dev'),
  BW_DEV_KEYCLOAK_ADMIN_USER: zString({ trim: true }).optional(),
  BW_DEV_KEYCLOAK_ADMIN_PASSWORD: zSecret().optional(),
});

/** `SEED_FORBIDDEN_IN_PROD` (403): `pnpm db:seed` refuses every environment except development and test. */
export class SeedForbiddenInProdError extends AppError {
  declare readonly code: 'SEED_FORBIDDEN_IN_PROD';

  constructor(nodeEnv: string) {
    super(
      'SEED_FORBIDDEN_IN_PROD',
      `db:seed refuses NODE_ENV=${nodeEnv}: it seeds development and test only`,
    );
  }
}

/**
 * Fails closed before any config or connection is read: the seed runs only when NODE_ENV is exactly
 * `development` or `test` (CONTEXT_PACK §10). An unset NODE_ENV is refused too.
 */
export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new SeedForbiddenInProdError(nodeEnv ?? 'unset');
  }
}
