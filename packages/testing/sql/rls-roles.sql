-- Blackwing Postgres role model (CONTEXT_PACK §7 "Rules", §8.6). Cluster-wide part.
--
-- Run once per cluster as a superuser (the bootstrap role), before rls-database.sql. Idempotent and
-- safe to run concurrently. Shared by @blackwing/testing (withPostgres) and the production database
-- bootstrap, so tests exercise exactly the role setup production uses.
--
--   bw_owner  Owns the schema and every table; migrations run as this role.
--             Not a superuser and no BYPASSRLS.
--   bw_app    The runtime role. Every query it runs is subject to RLS: not a superuser, no BYPASSRLS,
--             never a member of bw_owner (table owners skip RLS unless FORCE ROW LEVEL SECURITY).
--
-- Both are created NOLOGIN. Whoever provisions the database grants LOGIN and sets passwords (or
-- creates login roles that are members of these roles). No credential is ever stored in this file.

DO $$
BEGIN
  BEGIN
    CREATE ROLE bw_owner NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  BEGIN
    CREATE ROLE bw_app NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
END
$$;

-- Re-assert the attributes on every run, so a pre-existing role can never keep a dangerous one.
ALTER ROLE bw_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE bw_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- bw_app must never be able to act as the owner.
DO $$
BEGIN
  IF pg_has_role('bw_app', 'bw_owner', 'MEMBER') THEN
    REVOKE bw_owner FROM bw_app;
  END IF;
END
$$;
