-- Base column mixins (DB-004, CONTEXT_PACK §7). Forward-only; custom (hand-written) migration.
-- Shared trigger function behind the `updated_at` mixin: every table attaches it with
-- `updatedAtTriggerSql(table)` from src/columns.ts. It runs inside the database, so raw SQL updates
-- bump `updated_at` exactly like ORM updates. The GREATEST() keeps it monotonic under clock skew and
-- clock_timestamp() (not now()) makes two updates in one transaction still differ.
CREATE OR REPLACE FUNCTION bw_set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := GREATEST(pg_catalog.clock_timestamp(), OLD.updated_at);
  RETURN NEW;
END
$$;
