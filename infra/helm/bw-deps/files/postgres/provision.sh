#!/usr/bin/env bash
# INFRA-010: idempotent Postgres provisioning, run by the post-install/post-upgrade `postgres-provision` Job.
#
# Runs as the cluster superuser and is safe to re-run on every upgrade:
#   1. the application roles: bw_app (runtime, NOBYPASSRLS, NOINHERIT) and bw_migrator (migrations),
#      created when missing and their passwords re-synced from the Secret on every run (rotation works);
#   2. packages/db/src/roles.sql (DB-001), applied to the blackwing database: the NOLOGIN owner, app,
#      operator and relay roles, plus the pgvector and pgcrypto extensions;
#   3. bw_migrator is granted bw_owner, so migrations run as the owner and bw_app never gets it;
#   4. the Keycloak role and database, never touching the RLS-protected blackwing database.
# Passwords reach psql as variables and are never echoed. The Job fails loudly on any error.
set -euo pipefail

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${BW_DB:?}"
: "${BW_APP_ROLE:?}" "${BW_APP_PASSWORD:?}" "${BW_MIGRATOR_ROLE:?}" "${BW_MIGRATOR_PASSWORD:?}"
: "${BW_KEYCLOAK_DB:?}" "${BW_KEYCLOAK_DB_USER:?}" "${BW_KEYCLOAK_DB_PASSWORD:?}"
ROLES_SQL="${BW_ROLES_SQL:-/bw/postgres/roles.sql}"

if [[ ! -r "$ROLES_SQL" ]]; then
  echo "postgres-provision: $ROLES_SQL is not mounted" >&2
  exit 1
fi

psql_admin() {
  psql -v ON_ERROR_STOP=1 -XtA -h "$PGHOST" -U "$PGUSER" -d postgres "$@"
}

# The Job starts right after install, before the StatefulSet has necessarily accepted connections.
for _ in $(seq 1 60); do
  if pg_isready -h "$PGHOST" -U "$PGUSER" -d postgres >/dev/null 2>&1; then break; fi
  sleep 5
done
pg_isready -h "$PGHOST" -U "$PGUSER" -d postgres >/dev/null

# 1. Login roles. The pattern is the same as infra/compose/keycloak/db-init.sh.
psql_admin -v app_role="$BW_APP_ROLE" -v app_password="$BW_APP_PASSWORD" \
  -v migrator_role="$BW_MIGRATOR_ROLE" -v migrator_password="$BW_MIGRATOR_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT', :'app_role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD %L',
  :'app_role', :'app_password') \gexec
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'migrator_role')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migrator_role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'migrator_role', :'migrator_password') \gexec
SQL

# 2. Cluster and per-database role model (DB-001). roles.sql is idempotent by design.
psql -v ON_ERROR_STOP=1 -XtA -h "$PGHOST" -U "$PGUSER" -d "$BW_DB" -f "$ROLES_SQL" >/dev/null

# 3. Migrations run as the owner. Membership is granted to the migrator only, never to bw_app.
psql -v ON_ERROR_STOP=1 -XtA -h "$PGHOST" -U "$PGUSER" -d "$BW_DB" \
  -v migrator_role="$BW_MIGRATOR_ROLE" <<'SQL' >/dev/null
GRANT bw_owner TO :"migrator_role";
SQL

# 4. Keycloak's own role and database.
psql_admin -v kc_db="$BW_KEYCLOAK_DB" -v kc_user="$BW_KEYCLOAK_DB_USER" -v kc_password="$BW_KEYCLOAK_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'kc_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'kc_user') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'kc_user', :'kc_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'kc_db', :'kc_user')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'kc_db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'kc_db') \gexec
SQL

echo "postgres-provision: roles, role model and keycloak database ready"
