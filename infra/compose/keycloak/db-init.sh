#!/usr/bin/env bash
# DEVENV-004: one-shot `keycloak-db` service. Creates (idempotently) Keycloak's own role and database
# in the shared dev Postgres, so it also works on a pgdata volume created before Keycloak existed.
# Keycloak gets a separate database and role: it never touches the RLS-protected `blackwing` DB.
# BW_KEYCLOAK_DB_RESET=yes drops and recreates the database first (`pnpm dev:keycloak:reset --yes`).
# The password is passed to psql as a variable and never echoed.
set -euo pipefail

: "${BW_KEYCLOAK_DB:?}" "${BW_KEYCLOAK_DB_USER:?}" "${BW_KEYCLOAK_DB_PASSWORD:?}"

psql_admin() {
  psql -v ON_ERROR_STOP=1 -XtA -d postgres \
    -v kc_db="$BW_KEYCLOAK_DB" -v kc_user="$BW_KEYCLOAK_DB_USER" -v kc_password="$BW_KEYCLOAK_DB_PASSWORD" "$@"
}

if [ "${BW_KEYCLOAK_DB_RESET:-}" = "yes" ]; then
  psql_admin <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'kc_db') \gexec
SQL
  echo "keycloak-db: dropped database for re-import"
fi

psql_admin <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'kc_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'kc_user') \gexec
-- Re-sync the password from .env on every start (rotating it in .env just works).
SELECT format('ALTER ROLE %I PASSWORD %L', :'kc_user', :'kc_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'kc_db', :'kc_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'kc_db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'kc_db') \gexec
SQL
echo "keycloak-db: ready"
