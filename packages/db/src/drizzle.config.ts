// drizzle-kit configuration for @blackwing/db. `pnpm db:generate` needs no database; `pnpm db:migrate`
// (src/migrate-main.ts) applies them as the owner role; drizzle-kit's own `migrate`/`push` are not used.
// BW_DB_OWNER_URL is only for ad-hoc drizzle-kit commands (studio, pull) against a dev database;
// drizzle-kit is a dev CLI outside @blackwing/config, so it reads the variable itself.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.BW_DB_OWNER_URL ?? '' },
  // Timestamped file names (DB-002) make parallel PRs collide less; `pnpm db:check` catches the rest.
  migrations: { table: '__drizzle_migrations', schema: 'drizzle', prefix: 'timestamp' },
});
