# Agent memory: storage runbook

Owner: the Model and Memory layer (`packages/memory`, `packages/db` schema `memories` and `technique_kb`).
Issue: MEMORY-001 (#214). Context Pack: §3.1, §7, §8.6, §8.7.

## What is stored

- `memories`: tenant-scoped agent memory (recon facts, finding lessons, compaction summaries, reflections).
  Row-level security forces tenant isolation (`memories_tenant_isolation`, FORCE RLS). A request without
  `app.tenant_id` fails closed.
- `technique_kb`: platform-global curated techniques. It has no `tenant_id` and no RLS. The app role
  (`bw_app`) has SELECT only. The pipeline role (owner) writes it.
- Both tables hold a `vector(384)` embedding (bge-small-en-v1.5), indexed with HNSW using cosine ops
  (`memories_embedding_hnsw_idx`, `technique_kb_embedding_hnsw_idx`). The HNSW parameters are owned by DB-005.

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| `MEMORY_EMBED_DIM_MISMATCH` (422) on write | An embedding is not 384 dimensions (pgvector rejects it). | Fix the embedding producer. The model must emit 384 dimensions. A different model needs a new column, not a new value. |
| `TENANT_CONTEXT_MISSING` (403) or `42704` on read | The query ran without `app.tenant_id` (no `withTenant`). | Route the query through `withTenant`. Never widen the policy. |
| `CHECK` violation (422) on write | Empty content or title, an unknown scope/source/trust value, or a run-scoped memory without `run_id`. | Fix the writer. The database is the last line of defence. |

## HNSW index-size monitoring

HNSW indexes live in memory during builds and grow with the row count. Watch their size and the ANN query latency:

```sql
-- Size of each vector index (run as a monitoring role, read-only).
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
 WHERE relname IN ('memories', 'technique_kb')
 ORDER BY pg_relation_size(indexrelid) DESC;

-- Sequential versus index scans on the memories table.
SELECT relname, seq_scan, idx_scan
  FROM pg_stat_user_tables
 WHERE relname = 'memories';
```

Slow ANN queries appear in the slow-query log under `<=>`. Alerting is deferred to MEMORY-007.
A large HNSW build needs `maintenance_work_mem` headroom for the session that runs the migration.
Query-time recall is tuned per transaction with `hnsw.ef_search` (`hnswEfSearchSql()` in `packages/db/src/vector.ts`).
