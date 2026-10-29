# @blackwing/memory

Per-tenant agent memory (pgvector) and the surface graph (Neo4j 5 Community).

## Surface-graph migrations (GRAPH-002)

Migrations live in `src/graph/migrations/NNNN_name.cypher`. They are forward-only and applied in lexical order.

| Command | Does |
|---|---|
| `pnpm graph:migrate` | Applies pending migrations. Safe at boot and in CI. |
| `pnpm graph:migrate:check` | Reports applied, pending, partial, drifted and missing migrations without writing. Exits non-zero unless the ledger matches the files. Use it as the CI gate. |

How it works:

- Each applied migration is a `(:_GraphMigration {id, checksum, status, statementsApplied, appliedAt})` node.
- Statements run one per call. `statementsApplied` is recorded after each one, so a crash resumes at the next
  statement. Every statement uses `IF NOT EXISTS`, which makes replaying the in-flight statement safe.
- A changed file on an applied (or in-flight) migration fails with `GRAPH_MIGRATION_DRIFT`. Nothing is re-applied.
- A `(:_GraphMigrationLock {name})` node, guarded by a unique constraint, serialises runs. A lock whose lease
  (10 minutes) has ended can be taken over.
- Statements must end with `;` at the end of their line. Lines starting with `//` are comments.
- Node keys include `tenantId` (§8.6). Neo4j Community has no property-existence constraints, so the required
  `tenantId` and `runId` properties are enforced by the application (GRAPH-004). Each run logs
  `graph.migration.mode` with `existence_constraints: 'application'`.

Integration tests (`pnpm test:int`, Docker required) cover a fresh apply, re-runs, drift, per-tenant uniqueness and
lock contention against a real Neo4j.
