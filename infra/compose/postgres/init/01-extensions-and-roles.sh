#!/usr/bin/env bash
# DEVENV-002: runs once, on an empty data volume (docker-entrypoint-initdb.d).
# - extensions: vector (pgvector) + pgcrypto;
# - RLS roles (CONTEXT_PACK §7, §8.6): an app role WITHOUT BYPASSRLS and a separate
#   migration-owner role that owns the database/schema. Table DDL belongs to packages/db.
# Passwords come from the container env (sourced from the untracked .env) and are passed to
# psql as variables, never echoed.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_role="$BW_APP_ROLE" -v app_password="$BW_APP_PASSWORD" \
  -v migrator_role="$BW_MIGRATOR_ROLE" -v migrator_password="$BW_MIGRATOR_PASSWORD" \
  -v db_name="$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migration owner: owns schema objects, runs packages/db migrations. Not a superuser.
CREATE ROLE :"migrator_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
  PASSWORD :'migrator_password';
-- App role: what every service connects as. Never BYPASSRLS, never owns tables, so RLS
-- policies (tenant_id = current_setting('app.tenant_id')::uuid) always apply to it.
CREATE ROLE :"app_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT
  PASSWORD :'app_password';

ALTER DATABASE :"db_name" OWNER TO :"migrator_role";
ALTER SCHEMA public OWNER TO :"migrator_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";
GRANT USAGE ON SCHEMA public TO :"app_role";

-- Whatever the migrator creates later is usable (DML only) by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO :"app_role";
SQL
