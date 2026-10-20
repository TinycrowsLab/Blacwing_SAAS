-- Migration prerequisites (KILL-001). Forward-only; runs as the owner role (bw_owner).
-- citext backs case-insensitive e-mail columns (soc_contacts.email). It is a trusted extension
-- (PostgreSQL 13+), so the database owner may create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
-- Fail early, with a clear message, if the cluster bootstrap (rls-roles.sql) has not created the
-- roles the RLS policies are granted to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bw_operator') THEN
    RAISE EXCEPTION 'roles bw_app and bw_operator must exist: run the rls-roles.sql bootstrap first';
  END IF;
END
$$;
