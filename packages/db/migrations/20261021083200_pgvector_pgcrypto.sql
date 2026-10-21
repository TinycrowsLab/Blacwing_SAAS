-- Vector and hashing extensions (DB-005, CONTEXT_PACK §5, §7). Custom (hand-written) migration; forward-only.
-- pgvector backs embedding columns (src/vector.ts: vector(384), HNSW indexes with cosine ops). pgcrypto is
-- for non-secret hashing and UUID fallback only; customer secrets never live in the database in plaintext
-- (they use OpenBao, SECRETS). Both are idempotent (IF NOT EXISTS), so a re-run after a partial apply is safe.
-- Keep this file free of other DDL: CREATE EXTENSION is the one statement a managed-Postgres operator may
-- need to enable by hand, and a separate step makes that failure easy to find in the logs.

-- Fail fast with guidance when the server does not ship pgvector (managed Postgres without the package).
-- Without this the CREATE EXTENSION below fails with a generic "extension does not exist" error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'pgvector is not available on this Postgres server (extension "vector" is needed for embeddings): install the pgvector package, or enable it on your managed Postgres (for example rds.extensions on RDS or Aurora), then re-run the migration';
  END IF;
END
$$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
