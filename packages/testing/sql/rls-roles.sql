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
--   bw_operator  The platform-operator path (KILL-001): the only role whose policy reaches global,
--             tenant-less rows such as `kill_events` with scope 'global'. Not a superuser, no
--             BYPASSRLS, NOINHERIT; bw_owner may SET ROLE to it, bw_app never.
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
  BEGIN
    CREATE ROLE bw_operator NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
END
$$;

-- Re-assert the attributes on every run, so a pre-existing role can never keep a dangerous one.
ALTER ROLE bw_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE bw_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE bw_operator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- bw_app must never be able to act as the owner or the platform operator.
DO $$
BEGIN
  IF pg_has_role('bw_app', 'bw_owner', 'MEMBER') THEN
    REVOKE bw_owner FROM bw_app;
  END IF;
  IF pg_has_role('bw_app', 'bw_operator', 'MEMBER') THEN
    REVOKE bw_operator FROM bw_app;
  END IF;
  -- Platform-operator tooling runs as the owner and assumes bw_operator with SET ROLE.
  IF NOT pg_has_role('bw_owner', 'bw_operator', 'MEMBER') THEN
    GRANT bw_operator TO bw_owner;
  END IF;
END
$$;
