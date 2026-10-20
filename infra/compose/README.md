# Local dependency stack (`docker-compose.dev.yml`)

The dev stack every app and integration test talks to. DEVENV-002 (#156) adds the skeleton and the core data
services. Keycloak, OpenBao, Temporal and the `obs` profile arrive with their own
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
| mailpit | `axllent/mailpit` | 11025 smtp (`BW_DEV_MAILPIT_SMTP_PORT`), 18025 ui (`BW_DEV_MAILPIT_UI_PORT`) | `smtp://127.0.0.1:11025`, UI `http://127.0.0.1:18025` |
| interactsh | `projectdiscovery/interactsh-server` | 18081 http (`BW_DEV_INTERACTSH_HTTP_PORT`), 15353 dns udp+tcp (`BW_DEV_INTERACTSH_DNS_PORT`) | `http://127.0.0.1:18081`, token `INTERACTSH_TOKEN` |
| temporal | `temporalio/auto-setup:1.29.7` (digest-pinned) | 17233 gRPC (`BW_DEV_TEMPORAL_PORT`) | `TEMPORAL_ADDRESS=127.0.0.1:17233`, namespace `blackwing-dev` |
| temporal-ui | `temporalio/ui:2.49.0` (digest-pinned) | 18233 (`BW_DEV_TEMPORAL_UI_PORT`) | http://127.0.0.1:18233 |

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

## Local TLS and `*.bw.localhost` (DEVENV-013)

`pnpm dev:tls` runs `infra/compose/tls/setup-tls.sh` (mkcert) and starts Traefik (compose profile `tls`, the same
proxy family as the k3s default ingress). It makes dev behave like production for the console session: HTTPS,
`Secure` + `HttpOnly` cookies and stable OIDC redirect URIs, with no browser warning.

| Hostname | Routes to | Upstream (override in `.env`) |
|---|---|---|
| `app.bw.localhost` | web console | `BW_TLS_UPSTREAM_WEB` (host `:3000`) |
| `api.bw.localhost` | api | `BW_TLS_UPSTREAM_API` (host `:13400`) |
| `auth.bw.localhost` | Keycloak | `BW_TLS_UPSTREAM_KEYCLOAK` (`keycloak:8080`) |
| `juice.bw.localhost` | Juice Shop (DEVENV-012) | `BW_TLS_UPSTREAM_JUICE` (`juice-shop:3000`) |

- **Ports.** Binding 443 needs privileges, so the default is `https://app.bw.localhost:18443` (HTTP `18000`
  redirects to HTTPS, dashboard `http://127.0.0.1:18082`, dev only). For plain `https://app.bw.localhost`, set
  `BW_DEV_TRAEFIK_HTTPS_PORT=443` where unprivileged low ports are allowed
  (`sysctl net.ipv4.ip_unprivileged_port_start=443`). Keycloak redirect URIs (DEVENV-004) must use the same port.
- **Certificates.** `setup-tls.sh` runs `mkcert -install` and writes a `*.bw.localhost` wildcard (plus the apex,
  `127.0.0.1`, `::1`) to `infra/compose/tls/certs/` (git-ignored; verified by `scripts/tls-setup.test.mjs`).
  The mkcert CA key stays in `mkcert -CAROOT` and is never copied or committed. Only the public CA cert is exported
  as `certs/rootCA.pem`. Re-run the script to renew: it is a no-op until 30 days before expiry, `--force` regenerates.
- **Name resolution.** `*.localhost` resolves to loopback on most systems (systemd-resolved, macOS, browsers). If it
  does not (some Linux resolvers, WSL, Node/curl): `setup-tls.sh --print-hosts` prints the `/etc/hosts` line to add.
- **CI / headless.** `mkcert -install` may be unable to update browser stores. Trust the CA in the runner, or run
  Node clients and Playwright with `NODE_EXTRA_CA_CERTS=infra/compose/tls/certs/rootCA.pem`.
- **Cookies.** The proxy sets `X-Forwarded-Proto: https`, so the BFF issues `Secure; HttpOnly; SameSite=Lax`
  cookies scoped to the exact host (`app.bw.localhost`). No HSTS is sent in dev.
- **Scope.** Production cert-manager/Let's Encrypt (INFRA) and the k3s ingress (DEVENV-014) are separate.

### Mailpit and interactsh (DEVENV-008)

`pnpm dev:deps mailpit interactsh` (both are also part of the default `pnpm dev:deps`).

- **Mailpit:** SMTP on `smtp://127.0.0.1:11025` (`SMTP_URL`), web UI and API at http://127.0.0.1:18025
  (`MAILPIT_UI_URL`). Mail is never relayed, so dev cannot contact real recipients. Storage is in memory and
  capped by `BW_DEV_MAILPIT_MAX_MESSAGES` (500); restart (`docker compose -p bwdev restart mailpit`) or use
  "Delete all" in the UI to reset. Healthcheck probes the UI `/readyz`.
- **interactsh:** local-only mode (`-skip-acme`, plain HTTP, no TLS; use mkcert from DEVENV-013 if TLS is needed).
  `INTERACTSH_URL=http://127.0.0.1:18081`; clients authenticate with `INTERACTSH_TOKEN`, which `pnpm dev:deps`
  generates into `.env` (the stack refuses to start without a token). Domain: `BW_DEV_INTERACTSH_DOMAIN`
  (`oob.bw.localhost`). Logs: `docker compose -p bwdev logs interactsh`.
- **Dev vs prod OOB:** the dev domain has no public DNS delegation, so only HTTP callbacks that reach
  `127.0.0.1:18081` (with the correlation id in the Host or path) and DNS queries sent directly to
  `127.0.0.1:15353` are observed. Blind-DNS callbacks from third-party resolvers, SMTP/LDAP listeners and
  wildcard TLS certificates need the production self-hosted domain (INFRA). Correlation tokens map to local
  interactions only.
- **Tenancy expectation:** in the real system OOB interactions become evidence (section 7) and must be
  tenant-scoped (section 8.6); the local server is a single shared instance, so `packages/oob` must scope
  correlation ids per tenant and run.
- **Checks:** `pnpm dev:deps:smoke` sends an SMTP message and reads it from the Mailpit API, and asserts
  interactsh rejects unauthenticated registration and accepts a token-authenticated registration and poll.

### Temporal (server, Web UI, namespace bootstrap)

`temporal` uses the dev Postgres for persistence and visibility (databases `temporal`, `temporal_visibility`, created
and migrated by the auto-setup image on every start). It waits for `postgres` to be healthy, and `temporal-ui` and
`temporal-bootstrap` wait for `temporal` to be healthy (`temporal operator cluster health`). The image is pinned by
digest to a known-good server: bumping it bumps the schema, so change image and schema expectations together.

`temporal-bootstrap` is a one-shot, idempotent job (`temporal/bootstrap.sh`): it creates namespace `blackwing-dev`
(or updates its retention if it exists) and registers the custom search attributes `runId`, `tenantId`,
`assessmentId` and `runState` (Keyword). Re-running it changes nothing that already exists.

- **Retention:** `BW_DEV_TEMPORAL_RETENTION` (default `72h`). Raise it (for example `168h`) when debugging old runs and
  re-run `docker compose ... up temporal-bootstrap`.
- **More search attributes:** `docker compose -p bwdev ... run --rm temporal-bootstrap` with
  `BW_TEMPORAL_SEARCH_ATTRIBUTES="runId:Keyword newAttr:Int"`, or
  `temporal operator search-attribute create --namespace blackwing-dev --name <n> --type <Keyword|Text|Int|Double|Bool|Datetime|KeywordList>`.
- **Env:** `TEMPORAL_ADDRESS=127.0.0.1:17233`, `TEMPORAL_NAMESPACE=blackwing-dev` (see `.env.example`).
- **Smoke:** `pnpm --filter @blackwing/worker test:int` runs a trivial TS SDK worker and workflow against the stack
  and lists it by search attribute; it then shows in the Web UI under namespace `blackwing-dev`.
- **Logs:** `docker compose -p bwdev -f infra/compose/docker-compose.dev.yml logs -f temporal` (level via
  `BW_DEV_TEMPORAL_LOG_LEVEL`). The `obs` profile (DEVENV-009) scrapes Temporal metrics.
- **Clock:** workflow timers (gate timeouts, windows) use the host clock; keep the host (and WSL) time synced, because
  skew shifts timers.
- **Payloads:** workflow inputs, outputs and signals must never contain plaintext secrets (pack section 8.7); pass
  references. The worker epic enforces this with a payload codec; dev Temporal holds no secrets beyond the DB
  credentials from `.env`.

## Vulnerable targets (profile `targets`, DEVENV-012)

Deliberately-vulnerable **training** apps used as authorised, local-only e2e assessment targets. They are not
part of `pnpm dev:deps`. Start them with `pnpm targets:up` (Juice Shop only, the common case) or
`pnpm targets:up --all`; stop them with `pnpm targets:down` (removes only target containers, never the shared
`bwdev` dependency stack); `pnpm targets:reset <target>` recreates one target with fresh state.

Rules: images pinned by digest (no drift, §8.9); own network `bw-targets` (never `bw-dev`); host ports bound
to `127.0.0.1` only, so nothing is exposed publicly; no `container_name`. Do not add exploit content here.

| Target | Asset `type` | Host URL (loopback) | Hostname on `bw-targets` | Notes |
|---|---|---|---|---|
| `juice-shop` | `web_app` | `http://127.0.0.1:13000` | `juice.bw.localhost` | Backs the DEVENV-011 seeded verified asset; used by `pnpm test:e2e`. ~0.8 GB RAM, ~60 s to healthy. |
| `crapi` | `api` | `http://127.0.0.1:13010` | `crapi.bw.localhost` | Multi-service (web, identity, community, workshop, postgres, mongo, mailhog); only the web gateway is published. ~2 GB RAM. |
| `vampi` | `api` | `http://127.0.0.1:13020` | `vampi.bw.localhost` | Small REST API. |
| `dvga` | `graphql` | `http://127.0.0.1:13030` | `dvga.bw.localhost` | GraphQL target. |
| `dvwa` | `web_app` | `http://127.0.0.1:13040` | `dvwa.bw.localhost` | Needs a one-time DB setup: open `/setup.php` and press "Create / Reset Database". `pnpm targets:reset dvwa` restores a clean state. |
| `webgoat` | `web_app` | `http://127.0.0.1:13050/WebGoat` | `webgoat.bw.localhost` | Slow start (up to ~2 min). ~1 GB RAM. |

Override a host port with `BW_TARGET_<NAME>_PORT` in `.env` if it collides. The `*.bw.localhost` names resolve
to loopback in browsers; TLS for them arrives with DEVENV-013. The crAPI sidecars use the upstream public demo
defaults (throwaway training values, not Blackwing secrets). Targeting stays gated by a verified asset and an
active standing authorisation even in dev (§8.1, §8.10).

## Troubleshooting

- **Volume from an older schema** (init scripts only run on an empty volume, so role or extension changes need a
  fresh one): `pnpm dev:deps:reset --yes`, then `pnpm dev:deps`. This deletes all local data in the stack, and the
  stack is shared by every worktree on the host.
- **Slow host, service reported unhealthy:** check `docker compose ... logs <service>`. Neo4j's first start
  (plugin install, store creation) can take up to two minutes.
