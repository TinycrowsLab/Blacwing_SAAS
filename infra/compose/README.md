# Local dependency stack (`docker-compose.dev.yml`)

The dev stack every app and integration test talks to. DEVENV-002 (#156) adds the skeleton and the core data
services. Keycloak, OpenBao, MinIO, Temporal, Mailpit, interactsh and the `obs` profile arrive with their own
issues and join the same file, network and project.

```bash
pnpm dev:deps                  # creates .env from .env.example (random dev passwords), starts the stack, waits for healthy
pnpm dev:deps postgres valkey  # start only some services
pnpm dev:deps:smoke            # asserts the acceptance checks below against the running stack
pnpm dev:deps:config           # docker compose config --quiet (lint)
pnpm dev:deps:reset --yes      # stops the stack and DROPS its volumes (pgdata, valkeydata, neo4jdata)
docker compose -p bwdev --env-file .env -f infra/compose/docker-compose.dev.yml logs -f <service>
```

## Rules

- **One project, `bwdev`,** shared by every worktree (top-level `name:`). No `container_name:`: it collides with
  other stacks on the host. Containers are `bwdev-<service>-1`.
- **Network `bw-dev`** (bridge). Services reach each other by service name (`postgres:5432`, `valkey:6379`,
  `neo4j:7687`).
- **Images are pinned by tag and digest** (CONTEXT_PACK §8.9). Renovate's `docker-compose` manager bumps both.
- **Host ports bind `127.0.0.1` only.** Nothing is exposed to the network.
- **Credentials live in the untracked `.env`.** Compose refuses to start when a password is unset; there are no
  default passwords. `.env` is created with mode `0600`, and existing values are never overwritten.
- `restart: unless-stopped`, generous `start_period`s, and CPU/memory limits sized for an 8 vCPU / 16 GB host.

## Services

| Service | Image | Host port (env override) | Connection (from the host) |
|---|---|---|---|
| postgres | `pgvector/pgvector:0.8.0-pg16` | 15432 (`BW_DEV_POSTGRES_PORT`) | `postgres://bw_app:<pw>@127.0.0.1:15432/blackwing` |
| valkey | `valkey/valkey:8.1-alpine` | 16379 (`BW_DEV_VALKEY_PORT`) | `redis://:<pw>@127.0.0.1:16379/0` |
| neo4j | `neo4j:5.26-community` | 17474 http (`BW_DEV_NEO4J_HTTP_PORT`), 17687 bolt (`BW_DEV_NEO4J_BOLT_PORT`) | `bolt://127.0.0.1:17687`, user `neo4j` |
| minio | `cgr.dev/chainguard/minio` | 19000 api (`BW_DEV_MINIO_PORT`), 19001 console (`BW_DEV_MINIO_CONSOLE_PORT`) | `http://127.0.0.1:19000`, path-style, region `us-east-1` |

**Port already in use:** set the override in `.env` (for example `BW_DEV_POSTGRES_PORT=25432`) and update the matching
URL. The container-side ports never change.

### PostgreSQL 16

`postgres/init/01-extensions-and-roles.sh` runs once, on an empty volume:

- `CREATE EXTENSION vector` (pgvector, bundled in the image) and `pgcrypto`.
- **`bw_migrator`**, the migration owner. It owns the database and the `public` schema and runs the `packages/db`
  migrations. `NOSUPERUSER NOBYPASSRLS`.
- **`bw_app`**, the role every service connects as. `NOSUPERUSER NOBYPASSRLS NOINHERIT`. It owns nothing, so RLS
  always applies to it, and it gets DML-only default privileges on whatever the migrator creates.
- `bw_admin`, the bootstrap superuser. Only the init scripts use it.

Table DDL and RLS policies belong to `packages/db` migrations. Every tenant table's policy reads the tenant from
the transaction-local setting that `withTenant` sets:

```sql
SET LOCAL app.tenant_id = '<tenant uuid>';
-- policy: USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
```

`current_setting(..., true)` returns NULL when the setting is missing, so the policy matches no rows (fails closed).

### Valkey 8

AOF persistence (`appendonly yes`, `everysec`), password required, `noeviction` with a 512 MB cap (a full cache
errors instead of silently dropping rate-limit or lock keys).

**Key-prefix convention (§8.6).** Every tenant-scoped key starts with `t:<tenantId>:`, followed by the owning
module and the key: `t:<tenantId>:<module>:<key>` (for example `t:0192…:ratelimit:api:<userId>`). Platform-wide
keys use `p:<module>:<key>`. Tenant IDs are UUIDs, so `t:<uuid>:` prefixes can never overlap. Code never builds
keys by hand: the shared Valkey helper takes the tenant from the request context and adds the prefix, and seed
data (DEVENV-011) uses the same helper.

### Neo4j 5 Community

Heap 512 MB to 1 GB and a 512 MB page cache (memory pressure on a dev host). APOC core comes from the image.

Neo4j Community has no property-existence constraints (`REQUIRE n.tenantId IS NOT NULL` is Enterprise only). So
`neo4j/bootstrap/start.sh` starts Neo4j, then installs a `before`-phase APOC trigger
(`neo4j/bootstrap/tenant-guard.cypher`) that aborts any transaction that:

- creates a node without a non-empty `tenantId` (`BW_TENANT_REQUIRED`), or
- removes or changes a node's `tenantId` (`BW_TENANT_IMMUTABLE`).

It also creates `tenantId` indexes per surface label and a per-tenant uniqueness constraint
(`neo4j/bootstrap/tenant-indexes.cypher`). It then **proves** the guard by trying to create a node without
`tenantId`, and only then writes the marker the healthcheck requires. If the guard cannot be verified, Neo4j stays
unhealthy (fails closed). The repository layer (`packages/memory`) still scopes every query by `tenantId`; the
trigger is the backstop.

### MinIO (S3 with Object Lock)

`pnpm dev:deps minio minio-init` (also part of the default `pnpm dev:deps`). The `minio-init` job runs
`minio/bootstrap.sh` with the `mc` image, so no host `mc` is needed (on many hosts `mc` is Midnight Commander).
`up --wait` returns only after the buckets exist.

- **Buckets:** `bw-evidence`, `bw-reports`, `bw-transcripts`, created with `mc mb --with-lock` (Object Lock can
  only be enabled at creation) and versioning on. A bucket that exists without lock fails the bootstrap, loudly.
  Fix: empty and delete that bucket, re-run.
- **Default retention:** GOVERNANCE, 1 day (`BW_DEV_MINIO_RETENTION_MODE`/`_DAYS`). Production S3 uses
  COMPLIANCE. Dev uses GOVERNANCE so an admin (root, with an explicit bypass) can reclaim disk; the app key can
  never bypass. Do not use COMPLIANCE locally unless you accept that nothing can free the space for the period.
- **UTC:** retention-until timestamps are UTC (`packages/time`); `retention_until` in `evidence_items` is stored
  and compared in UTC.
- **Legal hold vs retention:** independent. Retention expires with time; a legal hold never does, and it blocks
  deleting a version even for root with a governance bypass. Only an explicit `legalhold clear` releases it.
  `verify.sh` proves both.
- **Scoped app key** (`BW_DEV_MINIO_APP_ACCESS_KEY` / `BW_DEV_MINIO_APP_PASSWORD`, policy `bw-app` in
  `minio/policy-app.json`): object get/put/delete (delete adds a delete marker), list, retention and legal-hold
  on the three buckets. Explicitly denied: `s3:DeleteObjectVersion`, `s3:BypassGovernanceRetention`, bucket
  deletion, versioning and lock configuration. No `admin:*`. Root credentials are for the bootstrap job and the
  console only.
- **Access path:** the AWS SDK v3 S3 client only (CONTEXT_PACK §5): `endpoint: http://127.0.0.1:19000`,
  `forcePathStyle: true`, `region: us-east-1`, the scoped key. Never the root key, never another client.
- **Per-tenant convention (§8.6):** every key is `<bucket>/<tenantId>/<module>/...`, with `<tenantId>` the tenant
  UUID. The evidence store derives the prefix from the request context, never from caller input, and in
  staging/prod binds the tenant into the KMS encryption context (`tenantId=<uuid>`) so a key from another
  tenant's prefix cannot decrypt it. MinIO dev has no KMS: only the prefix applies locally.
- **Console (dev only):** http://127.0.0.1:19001 with the root credentials from `.env`. Metrics:
  `/minio/v2/metrics/cluster` on the API port (public in dev so the `obs` profile can scrape it).
- **Disk:** locked objects cannot be removed until retention ends. To reclaim space: wait for expiry, or as root
  `mc rm --recursive --force --versions --bypass` (GOVERNANCE only, and never on held versions). Never delete
  the `miniodata` volume while other worktrees depend on the shared stack.
- **Checks:** `pnpm dev:deps:smoke` runs `minio/verify.sh` (WORM overwrite/delete rejected, legal hold, scoped
  key cannot do admin or version deletes). Re-running the bootstrap is a no-op.

## Troubleshooting

- **Volume from an older schema** (init scripts only run on an empty volume, so role or extension changes need a
  fresh one): `pnpm dev:deps:reset --yes`, then `pnpm dev:deps`. This deletes all local data in the stack, and the
  stack is shared by every worktree on the host.
- **Slow host, service reported unhealthy:** check `docker compose ... logs <service>`. Neo4j's first start
  (plugin install, store creation) can take up to two minutes.
