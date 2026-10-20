#!/usr/bin/env bash
# DB-001 role model on the dev stack: runs once, on an empty data volume, after 01-extensions-and-roles.sh.
# Applies packages/db/src/roles.sql (mounted read-only at /bw/db/roles.sql), which creates the NOLOGIN
# roles bw_owner, bw_app and bw_operator that the migrations require, then makes the dev login role
# for migrations (`bw_migrator`) a member of bw_owner, as packages/db/src/env.ts expects. bw_app stays
# NOINHERIT and is never a member of bw_owner or bw_operator (roles.sql revokes any such grant).
set -euo pipefail

ROLES_SQL=/bw/db/roles.sql
if [[ ! -r "$ROLES_SQL" ]]; then
  echo "02-db-roles: $ROLES_SQL is not mounted (docker-compose.dev.yml postgres volumes)" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$ROLES_SQL"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_role="$BW_MIGRATOR_ROLE" <<'SQL'
GRANT bw_owner TO :"migrator_role";
SQL
