-- Runs after 0001 (migrations apply in file-name order) and needs the pgvector extension that
-- rls-database.sql installs.
ALTER TABLE rls_probe ADD COLUMN embedding vector(3);
