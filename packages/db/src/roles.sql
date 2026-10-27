-- Blackwing Postgres role definitions (DB-001; CONTEXT_PACK §7 "Rules", §8.6).
--
-- Run as a superuser while connected to the target database, before any migration. Idempotent.
-- It is the cluster part (packages/testing/sql/rls-roles.sql) followed by the per-database part
-- (packages/testing/sql/rls-database.sql), verbatim: Testcontainers tests apply those two files, so
-- tests exercise exactly these definitions (src/roles.test.ts fails on any drift).
--
-- Summary: bw_owner owns the schema and runs migrations; bw_app is the runtime role (LOGIN is
-- granted by the provisioner) with CONNECT on the database and USAGE on the schema only, table DML
-- arriving with each migration through the owner's default privileges. Neither is SUPERUSER or
-- BYPASSRLS, and PUBLIC keeps no privilege on the database or the public schema.

-- ---- cluster part (rls-roles.sql) ----
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
--   bw_relay  The outbox relay (WORKFLOW-012): the only role whose policies reach `outbox` rows across
--             tenants (claim and mark them, nothing else). Not a superuser, no BYPASSRLS, NOINHERIT;
--             bw_owner may SET ROLE to it (without inheriting it), bw_app never. The relay then
--             dispatches each row under that row's own tenant context on the app role.
--
-- All are created NOLOGIN. Whoever provisions the database grants LOGIN and sets passwords (or
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
  BEGIN
    CREATE ROLE bw_relay NOLOGIN;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
END
$$;

-- Re-assert the attributes on every run, so a pre-existing role can never keep a dangerous one.
ALTER ROLE bw_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE bw_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE bw_operator NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE bw_relay NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- bw_app must never be able to act as the owner or the platform operator.
DO $$
BEGIN
  IF pg_has_role('bw_app', 'bw_owner', 'MEMBER') THEN
    REVOKE bw_owner FROM bw_app;
  END IF;
  IF pg_has_role('bw_app', 'bw_operator', 'MEMBER') THEN
    REVOKE bw_operator FROM bw_app;
  END IF;
  IF pg_has_role('bw_app', 'bw_relay', 'MEMBER') THEN
    REVOKE bw_relay FROM bw_app;
  END IF;
  -- Platform-operator tooling runs as the owner and assumes bw_operator with SET ROLE.
  IF NOT pg_has_role('bw_owner', 'bw_operator', 'MEMBER') THEN
    GRANT bw_operator TO bw_owner;
  END IF;
  -- SET only, no INHERIT: the owner can assume the relay role (tests and tooling do) but never gains
  -- its policies by being the owner, so FORCE ROW LEVEL SECURITY keeps binding the owner on `outbox`.
  GRANT bw_relay TO bw_owner WITH INHERIT FALSE, SET TRUE;
END
$$;

-- ---- per-database part (rls-database.sql) ----
-- Blackwing Postgres role model (CONTEXT_PACK §7 "Rules", §8.6). Per-database part.
--
-- Run as a superuser while connected to the target database, after rls-roles.sql and before any
-- migration. Idempotent.
--
-- Every tenant table then follows the §7 pattern in its own migration:
--   ALTER TABLE t ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE t FORCE ROW LEVEL SECURITY;
--   CREATE POLICY t_tenant_isolation ON t
--     USING (tenant_id = current_setting('app.tenant_id')::uuid)
--     WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- A session without `SET LOCAL app.tenant_id` errors out on those tables: a missing tenant context
-- fails closed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Only the owner creates objects; the app role may only use them.
ALTER SCHEMA public OWNER TO bw_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bw_app;
-- The platform-operator path (KILL-001) only reaches what a migration grants it explicitly (global
-- kill events); it gets no default table privileges.
GRANT USAGE ON SCHEMA public TO bw_operator;
-- The outbox relay (WORKFLOW-012) likewise only reaches what a migration grants it explicitly.
GRANT USAGE ON SCHEMA public TO bw_relay;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO bw_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bw_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bw_relay', current_database());
END
$$;

-- Objects the owner creates later (in migrations) are usable by the app role, and nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO bw_app;
