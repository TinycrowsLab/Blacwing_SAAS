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

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO bw_owner', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bw_app', current_database());
END
$$;

-- Objects the owner creates later (in migrations) are usable by the app role, and nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bw_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bw_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO bw_app;
