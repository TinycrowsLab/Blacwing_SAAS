// drizzle-kit configuration for @blackwing/db. `pnpm db:generate` needs no database; `pnpm db:migrate`
// applies the forward-only migrations as the owner role (§7: migrations never run as bw_app), using
// BW_DB_OWNER_URL. drizzle-kit is a dev CLI outside @blackwing/config, so it reads the variable itself.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.BW_DB_OWNER_URL ?? process.env.MIGRATION_DATABASE_URL ?? '' },
  migrations: { table: '__drizzle_migrations', schema: 'drizzle' },
});
