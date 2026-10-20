// Environment of `pnpm db:seed` (DEVENV-011), parsed through @blackwing/config.

import { z } from 'zod';

import { type EnvSource, zSecret, zSecretUrl, zString, zUrl } from '@blackwing/config';

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
  BW_DEV_KEYCLOAK_PUBLIC_URL: zUrl({ protocols: ['http:', 'https:'] }).default(
    'http://localhost:18080',
  ),
  BW_DEV_KEYCLOAK_REALM: zString({ trim: true }).default('blackwing-dev'),
  BW_DEV_KEYCLOAK_ADMIN_USER: zString({ trim: true }).optional(),
  BW_DEV_KEYCLOAK_ADMIN_PASSWORD: zSecret().optional(),
});
