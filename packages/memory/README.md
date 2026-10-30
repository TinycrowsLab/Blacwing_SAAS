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

## Surface-graph repository (GRAPH-004, §8.6)

`SurfaceGraphRepository` is the only sanctioned way to read or write the surface graph. Neo4j has no row-level
security, so the repository is the enforcement point for tenant isolation.

- Obtain it with `withTenantGraph(tenantId, (repo) => ...)`. The ambient tenant (`@blackwing/db/tenant-context`) is
  authoritative: every query binds `$tenantId` from it, whatever the caller passes.
- With no tenant context the call throws `GRAPH_NO_TENANT_CONTEXT`; a node or edge whose `tenantId` differs from the
  context throws `GRAPH_TENANT_MISMATCH`. Both happen before any query is sent.
- Writes (`writeNode`, `writeEdge`) are keyed on the contract natural key (`naturalKey` in `@blackwing/contracts`).
  `writeEdge` resolves to `false` when an endpoint is not stored in the tenant.
- Reads (`getNode`, `listNodes`, `getNeighbours`, `countByTenant`) parse every stored value through the GRAPH-003
  contracts. `getNeighbours` is limited to 1 or 2 hops and `NEIGHBOUR_LIMIT` nodes, and reports `truncated`.
- Failures are typed: a transient failure the driver gave up on is `GRAPH_QUERY_UNAVAILABLE` (503, retryable); any
  other query failure is `GRAPH_QUERY_FAILED`. Retries happen inside the driver's managed transactions, bounded by
  `NEO4J_MAX_TX_RETRY_MS`.
- All Cypher lives in `src/graph/cypher.ts`. `cypher.test.ts` fails if a template does not bind `$tenantId`.
- The cross-tenant suite is `src/graph/repository.int.test.ts` (Testcontainers Neo4j).

## Surface upsert (GRAPH-007)

`SurfaceGraphRepository.upsertNodes` and `upsertEdges` are how recon and ingest write the surface model. They are
batched, idempotent and keep provenance across runs.

- A batch carries one run (`provenance.runId`). A mixed batch is refused with `VALIDATION_FAILED`, since its audit
  event names one run. Everything is validated first (contract, tenant, run), so a refused batch writes nothing.
- Nodes are grouped by kind and written with `UNWIND $rows MERGE` on the tenant and natural key. Chunks of
  `GRAPH_UPSERT_BATCH` rows (default 500, 1 to 5000) run one transaction each. A failing chunk is named in the error
  (`chunk 2 of 3`) and keeps its code. Earlier chunks stay committed; a retry is safe because the upsert is idempotent.
- An existing node keeps its `firstSeenAt`. Its confidence is the larger of the two values, and its `lastSeenAt` is the
  lexically larger ISO-UTC value. Commutative rules mean concurrent sandboxes converge on one state.
- Each run that sees a node adds an `OBSERVED_IN` edge to its `(:Run)` node. Each `(run, natural key, tool)` adds one
  `(:Observation)`, merged by key, so replaying a batch adds none.
- An edge whose endpoint is absent creates a placeholder (`stub: true`, confidence 0) in the same transaction. Stubs are
  hidden from node reads and counts until an observation upgrades them.
- Provenance is advisory. No scope, policy or budget decision reads confidence (§8.11). Only names and metadata are
  written (§8.7).
- Each call emits `graph.surface.upserted` with the run and the counts (§8.8), after its writes commit. A repository
  without an audit sink refuses the upsert (`GRAPH_AUDIT_UNBOUND`) before any query.
- The `graph.upsert` span carries `runId`, `nodeCount` and `edgeCount`. The metrics hooks are `upsertCounted` and
  `upsertBatchMs`.

The Run and Observation constraints are in migration `0002_run_observation_constraints.cypher`. The cross-run and
concurrency suite is `src/graph/repository.upsert.int.test.ts` (Testcontainers Neo4j).
