# Local dependency stack (`docker-compose.dev.yml`)

The dev stack every app and integration test talks to. DEVENV-002 (#156) adds the skeleton and the core data
services; DEVENV-004 (#158) adds Keycloak and DEVENV-005 (#159) adds OpenBao. Later services join the
same file, network and project.

```bash
pnpm dev:deps                  # creates .env from .env.example (random dev passwords), starts the stack, waits for healthy
pnpm dev:deps postgres valkey  # start only some services
pnpm dev:deps:smoke            # asserts the acceptance checks below against the running stack
pnpm dev:openbao:bootstrap     # idempotent OpenBao setup: Transit + tenant keys, KV v2, policies, app token
pnpm dev:deps:config           # docker compose config --quiet (lint)
pnpm dev:deps:reset --yes      # stops the stack and DROPS its volumes (pgdata, valkeydata, neo4jdata, openbaodata)
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
| keycloak | `quay.io/keycloak/keycloak:26.4.2` | 18080 (`BW_DEV_KEYCLOAK_PORT`) | issuer `http://localhost:18080/realms/blackwing-dev` |
| openbao | `openbao/openbao:2.4.3` | 18200 (`BW_DEV_OPENBAO_PORT`) | `OPENBAO_ADDR=http://127.0.0.1:18200`, app token from the file named by `OPENBAO_TOKEN_FILE` |

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

`postgres/init/02-db-roles.sh` then applies `packages/db/src/roles.sql` (mounted read-only): it creates the
NOLOGIN roles `bw_owner`, `bw_app`, `bw_operator` and `bw_relay` of the DB-001 role model, which the first migration
requires, and makes `bw_migrator` a member of `bw_owner`. A volume created before this script existed lacks
those roles; recreate it with `pnpm dev:deps:reset --yes`.

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
A search attribute already registered with another type fails the job (`SEARCH_ATTR_TYPE_CONFLICT`) and is never
changed. The deploy-time equivalent is `pnpm --filter @blackwing/worker register:search-attributes`; see
[docs/runbooks/search-attributes.md](../../docs/runbooks/search-attributes.md).

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

**TLS for `juice.bw.localhost`.** The bw-dev proxy above deliberately does NOT route to Juice Shop: it is on
`bw-dev` only and no bw-dev service may join `bw-targets` (asserted in `scripts/targets.test.mjs`). Instead a
second Traefik, `traefik-targets` (profile `targets-tls`), lives only on `bw-targets` and is published on
`127.0.0.1:13443` (HTTP `13080` redirects). Start it with `pnpm targets:up --tls` (needs the mkcert certs from
`pnpm dev:tls` setup) and browse `https://juice.bw.localhost:13443`. There is no bw-dev <-> bw-targets bridge.

**E2E / seed contract.** `BW_TARGET_JUICE_SHOP_URL` (default `http://127.0.0.1:13000`) is the URL `pnpm test:e2e`
must use for Juice Shop. The seeded verified asset is addressed by the gateway URL
`BW_TARGET_JUICE_SHOP_GATEWAY_URL` (default `http://juice-shop:3000`, the service name on `bw-targets`). The
`bw-targets` network has a fixed lab subnet, `172.30.250.0/24` (#880): the seed admits that range as the only
private-range scope rule, and only in `dev` or `test` for the verified lab asset. Loopback is never in scope. `pnpm targets:smoke` brings Juice Shop up,
asserts it answers on that URL and, via `docker inspect`, that its networks are exactly `[bw-targets]`.

**crAPI.** Its gateway template also needs a chatbot upstream. The real `crapi-chatbot` needs an online LLM key,
so `crapi-chatbot` here is an inert offline stub (alpine busybox `httpd`, 404s, no egress) on alias `chatbot`;
chatbot features are unavailable locally.

Override a host port with `BW_TARGET_<NAME>_PORT` in `.env` (or the shell; the driver reads both, like compose) if it collides. The `*.bw.localhost` names resolve
to loopback in browsers; TLS for them arrives with DEVENV-013. The crAPI sidecars use the upstream public demo
defaults (throwaway training values, not Blackwing secrets). Targeting stays gated by a verified asset and an
active standing authorisation even in dev (§8.1, §8.10).

### Observability profile `obs` (DEVENV-009)

Opt-in: `pnpm dev:deps:obs` starts the core stack plus the OTel Collector, Prometheus, Loki, Tempo and Grafana
(compose profile `obs`). `pnpm dev:deps` never starts them. `pnpm dev:deps:reset --yes` drops their volumes too,
and `pnpm dev:deps:obs:smoke` proves the pipeline end to end.

| Service | Host port (env) | Role |
|---|---|---|
| OTel Collector | 14317 gRPC / 14318 HTTP (`BW_DEV_OTEL_GRPC_PORT`, `BW_DEV_OTEL_HTTP_PORT`), 13133 health | Single OTLP ingest point |
| Prometheus | 19090 (`BW_DEV_PROMETHEUS_PORT`) | Metrics. Scrapes the collector, MinIO, Temporal, Loki, Tempo |
| Loki | 13100 (`BW_DEV_LOKI_PORT`) | Logs, via the collector's OTLP exporter |
| Tempo | 13200 (`BW_DEV_TEMPO_PORT`) | Traces, via the collector's OTLP exporter |
| Grafana | http://127.0.0.1:13001 (`BW_DEV_GRAFANA_PORT`) | `admin` / `BW_DEV_GRAFANA_ADMIN_PASSWORD` from `.env` |

- **Send telemetry from an app:** `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318` (OTLP/HTTP, already in
  `.env.example`); for gRPC use `http://127.0.0.1:14317` with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`. Apps go through
  `packages/telemetry` and `packages/logger`; set `OTEL_SERVICE_NAME` so panels can group by `service_name`.
- **Claude Code telemetry** (agent-runtime, or a dev session): `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
  `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` (or
  `http/protobuf`) and the same `OTEL_EXPORTER_OTLP_ENDPOINT`.
- **Grafana** opens on the provisioned "Blackwing overview (starter)" dashboard (folder Blackwing) with Prometheus,
  Loki and Tempo datasources. To add a panel, edit
  `infra/compose/obs/grafana/dashboards/blackwing-overview.json` (or build it in the UI, export the JSON, and commit
  it; provisioned dashboards are read-only in the UI). The run and agent-session panels are placeholders for
  `bw_runs_started_total` and `bw_agent_sessions_total` until the apps emit them. To scrape a new target, add a job to
  `infra/compose/obs/prometheus.yml`.
- **RAM:** about 1.5 GB of limits across the five services (collector 512 MB, the rest 384 MB each). Skip the
  profile on a tight host. Container logs: `docker compose -p bwdev -f infra/compose/docker-compose.dev.yml --profile obs logs -f otel-collector`.
- **Health:** Prometheus, Loki and Grafana have compose healthchecks. The collector and Tempo images have no shell,
  so `pnpm dev:deps:obs` polls `http://127.0.0.1:13133/` (collector `health_check`) and Tempo `/ready` after
  `up --wait`. A collector config error makes the container exit and restart; validate before starting with
  `docker run --rm -v "$PWD/infra/compose/obs:/o:ro" <collector image> validate --config=/o/otel-collector.yaml`
  (the unit tests do this).
- **No secrets or PII in telemetry:** redaction happens upstream in `packages/logger` before export (pack section 8.7).
  The collector only transports; its `redaction` processor on traces is defence in depth, never a substitute. Do not
  add collector processors or exporters that copy attributes elsewhere.
- **Time:** OTLP timestamps are UTC (`packages/time`); a skewed host clock shifts spans and can make Loki reject
  old samples, so keep WSL time synced.
- **Dev only:** all ports bind 127.0.0.1, Grafana sign-up and usage reporting are off, and no exporter leaves the
  `bw-dev` network. Production monitoring and Alertmanager routing belong to INFRA.

### Keycloak 26 (realm `blackwing-dev`, DEVENV-004)

**Dev only.** The realm allows password login and has no mandatory MFA. Staging and production require MFA and
real IdP brokering (production Keycloak/IdP config belongs to the infra epic); never reuse this realm or its
users there.

- `keycloak-db` (one-shot) creates Keycloak's own role `bw_keycloak` and database `keycloak` in the dev Postgres,
  idempotently, so it also works on an older `pgdata` volume. Keycloak never touches the RLS-protected app DB.
- `keycloak` runs `start-dev --import-realm` with `keycloak/realm-export.json`. The first start imports the
  realm. Later starts log `Realm 'blackwing-dev' already exists. Import skipped` (Keycloak's `IGNORE_EXISTING`
  strategy), so changes made in the admin console survive restarts until you re-import.
- `${BW_DEV_KEYCLOAK_*}` placeholders in the export (client secrets, the test-user password) are resolved from the
  container env at import. `.env` gets random values for them, so nothing secret is committed.
- Health: `/health/ready` on the management port 9000 (in-network only). Metrics: `http://keycloak:9000/metrics`
  for the `obs` profile (DEVENV-009). Logs are JSON on stdout. The first boot can take 1-2 minutes
  (`start_period: 180s`).
- Admin console: `http://localhost:18080/admin`, user `BW_DEV_KEYCLOAK_ADMIN_USER` / `BW_DEV_KEYCLOAK_ADMIN_PASSWORD`.

| Client | Type | Use |
|---|---|---|
| `bw-console-bff` | confidential, Auth Code + PKCE (S256 required), no password/implicit grant | The Next.js BFF. Redirect URIs exactly `https://app.bw.localhost/auth/callback`, `https://app.bw.localhost:18443/auth/callback` (the TLS proxy's default port) and `http://localhost:3000/auth/callback`. |
| `bw-api` | confidential, no login flows | Resource server: the `aud` of console and CI tokens. |
| `bw-ci` | confidential, client credentials only | CI/CD service account (`ci-pipeline`, tenant `acme`). |

Realm roles map the §1.2 personas: `appsec-engineer`, `asset-owner`, `developer`, `org-admin`, `auditor` and
`ci-pipeline` (attribute `bw.scope=tenant`), and `platform-operator` (`bw.scope=platform`). Groups wire them:
`/acme/<role>s` for the demo tenant and `/platform-operators`. Tokens carry `realm_access.roles` and a `tenant`
claim (user attribute, editable by admins only). The Platform Operator holds no tenant role and no tenant claim.

| Test user (password `BW_DEV_KEYCLOAK_TEST_USER_PASSWORD`) | Role | Tenant |
|---|---|---|
| `appsec@acme.test` | `appsec-engineer` | `acme` |
| `owner@acme.test` | `asset-owner` | `acme` |
| `dev@acme.test` | `developer` | `acme` |
| `admin@acme.test` | `org-admin` | `acme` |
| `auditor@acme.test` | `auditor` | `acme` |
| `operator@blackwing.test` | `platform-operator` | none |

```bash
pnpm dev:keycloak:check         # validate realm-export.json (roles, users, clients, no secrets, canonical form)
pnpm dev:keycloak:smoke         # Auth Code + PKCE login as every test user via the BFF redirect URI; token claims
pnpm dev:keycloak:smoke --restart  # also proves a restart skips the import of the existing realm
pnpm dev:keycloak:export        # re-export the running realm into realm-export.json (sanitised)
pnpm dev:keycloak:reset --yes   # drop the Keycloak DB and re-import realm-export.json
```

**Re-export workflow.** Change the realm in the admin console, run `pnpm dev:keycloak:export`, review the diff of
`infra/compose/keycloak/realm-export.json`, then commit. The export runs `kc.sh export` inside the container and
keeps only the managed sections (realm settings, realm roles, groups, test users, `bw-*` clients and the user
profile). It strips ids, timestamps and password hashes, and puts the placeholders back for secrets, so the result
is stable and committable. To manage a new section or setting, add it to the keep-lists in
`scripts/keycloak-realm.mjs`. `pnpm dev:keycloak:check` fails if the file is not in canonical form.

**Keep in sync.** The redirect URIs and web origins (`CONSOLE_ORIGINS`, `BFF_CALLBACK_PATH` in
`scripts/keycloak-realm.mjs`) must match the BFF route and the `*.bw.localhost` proxy (DEVENV-013). The issuer host
is `BW_DEV_KEYCLOAK_PUBLIC_URL`; containers can reach Keycloak at `http://keycloak:8080` (dynamic backchannel).
### OpenBao 2.4 (secrets and per-tenant keys)

OpenBao is Blackwing's secrets and key service (pack §5, ADR-0009): **Transit** holds one envelope key per
tenant and **KV v2** at `secret/` holds platform secrets. Credentials are always used by reference (§8.7).

```bash
pnpm dev:deps openbao            # start it (healthcheck: /v1/sys/health)
pnpm dev:openbao:bootstrap       # configure it; safe to re-run at any time
```

`openbao/bootstrap.sh` (curl + jq, against the HTTP API) waits for `/v1/sys/health`, then makes sure that:

- `transit/` is enabled and `transit/keys/tenant-<slug>` exists for every slug in `BW_DEV_OPENBAO_TENANTS`
  (default `acme`): `aes256-gcm96`, not exportable, no plaintext backup, deletion disabled;
- `secret/` is KV v2, with dev placeholders at `secret/platform/smtp` (local Mailpit) and
  `secret/platform/interactsh` (interactsh-local), written only when absent (`cas=0`);
- policies `bw-app-platform` (read `secret/data/platform/*`, list its metadata) and `bw-app-tenant-<slug>`
  (`encrypt`, `decrypt`, `rewrap`, `datakey/*` on that tenant's key only) exist. The app token cannot read
  other KV paths, read or export keys, rotate, delete, touch `sys/*` or mint tokens;
- an app token from the orphan, periodic token role `bw-app` is in `.bw-dev/openbao/app-token` (mode `0600`,
  in the ignore list). A still-valid token with the same policies is kept; otherwise a new one is issued.
- AppRole auth is enabled with the SECRETS-001 roles `bw-kek-app` (encrypt/decrypt/rewrap/rotate on `tenant-*`)
  and `bw-kek-provisioner` (create/configure tenant keys and their lifecycle marker), plus `bw-run-ca` for the
  sandbox controller's per-run CA keys (SANDBOX-008, `secret/data/tenants/+/runs/+/run-ca/*` only); their policies are
  `openbao/policies/*.hcl`, and `<role>.role-id` / `<role>.secret-id` (mode `0600`) land in
  `.bw-dev/openbao/`. Apps pass them as `OPENBAO_ROLE_ID` / `OPENBAO_SECRET_ID` to `@blackwing/secrets`.
  Tenant keys are created with `deletion_allowed:true` so they can be crypto-shredded; always disable a
  key (`disableTenantKek`) before deleting it, so in-flight decrypts fail closed instead of racing the delete.

Re-running changes nothing that exists: no duplicate mounts, key versions or secret versions. The script never
prints a token. Apps read `OPENBAO_ADDR` and `OPENBAO_TOKEN_FILE` from `.env` (`.env.example` lists them) and
never see the root token.

**Root token.** `BW_DEV_OPENBAO_ROOT_TOKEN` is random per machine and lives only in the untracked `.env`
(`pnpm dev:deps` generates every empty `*_TOKEN` and `*_PASSWORD`). The server refuses to start without it. Only
the bootstrap uses it.

**Ephemeral by default.** `-dev` keeps everything in memory: restarting the container loses every key, secret
and token, and data encrypted with the old keys can no longer be decrypted. Re-run the bootstrap after a restart.
For persistence set `BW_DEV_OPENBAO_STORAGE=file` in `.env` and recreate the container
(`pnpm dev:deps openbao`). The file backend (`openbao/config/storage-file.hcl`, volume `openbaodata`) starts
sealed. The bootstrap initialises it once with a single key share, stores the unseal key and root token in
`.bw-dev/openbao/init.json` (mode `0600`), and unseals it on every run. That is a dev-only shortcut: production
uses HA OpenBao with auto-unseal (INFRA epic).

**Audit.** OpenBao 2.x accepts audit devices only from config, so `openbao/config/audit.hcl` declares a file
device that writes JSON lines to stdout with secrets HMAC'd: `docker compose ... logs openbao` is the dev audit
trail. The bootstrap fails if no audit device is enabled.

#### Envelope encryption (what `packages/crypto` builds on)

1. **Encrypt.** Ask for a fresh data key: `POST transit/datakey/plaintext/tenant-<slug>` (`bits: 256`). The
   response has `plaintext` (the DEK, base64) and `ciphertext` (the DEK wrapped by the tenant key,
   `vault:v<N>:...`). Encrypt the payload locally with AES-256-GCM under the DEK, store
   `{ wrappedDek: ciphertext, iv, tag, payload }`, and drop the plaintext DEK from memory. Use
   `transit/datakey/wrapped/...` when the caller only needs to store a key for later.
2. **Decrypt.** `POST transit/decrypt/tenant-<slug>` with the wrapped DEK returns the DEK; decrypt the payload
   locally. The tenant comes from the request context, never from the stored blob, so a blob from tenant A
   cannot be opened with tenant B's key.
3. **Rotate.** `bao write -f transit/keys/tenant-<slug>/rotate` (root/operator only) adds a key version. New
   data keys use the latest version; old wrapped DEKs still decrypt because every version is kept until
   `min_decryption_version` is raised. `POST transit/rewrap/tenant-<slug>` re-wraps an old DEK under the latest
   version without exposing it; run it over stored blobs before raising `min_decryption_version`.

Small values (tokens, connector credentials) can use `transit/encrypt` / `transit/decrypt` directly. Plaintext
secrets never go into logs, the model or a sandbox (§8.7).

## Orchestration: `pnpm dev:deps`, `pnpm dev:doctor`, `pnpm dev` (DEVENV-010)

`pnpm dev:deps` (`scripts/dev-deps.mjs` → `scripts/dev-orchestrate.mjs`) brings the stack up in a fixed order and
exits 0 only when everything is ready:

1. **Preflight**: `docker info` must answer (otherwise: start Docker, see
   [`docs/runbooks/dev-host-bootstrap.md`](../../docs/runbooks/dev-host-bootstrap.md)); it warns when Docker has
   less than 6 GiB memory or 2 CPUs.
2. **Lock**: a host-wide lockfile (`$TMPDIR/bwdev-dev-deps.lock`, holding the pid) stops two runs (from any
   worktree) from overlapping. A lock left by a killed run (dead pid) is taken over.
3. **Core services**: `docker compose up -d` of postgres, valkey, neo4j, minio, openbao, mailpit, interactsh,
   temporal and temporal-ui, then `scripts/wait-for-health.mjs` polls `docker compose ps` until each is healthy,
   printing a per-service table.
4. **Bootstraps, strictly in order**, each gated on its own service: Neo4j tenant guard + indexes (re-applied
   and re-verified) → OpenBao transit (`infra/compose/openbao/bootstrap.sh`) → MinIO buckets (`minio-init`) →
   Temporal namespace (`temporal-bootstrap`) → Keycloak (`keycloak-db`, then realm import; the run checks that
   `/realms/blackwing-dev` is served).

A service that turns `unhealthy`, a job that exits non-zero, or a timeout (300 s per gate) fails fast. The error
names the service, prints its last 30 log lines (credential-looking lines and `.env` secret values are redacted),
and suggests `pnpm dev:deps:reset --yes` for volumes left over from an older schema. Every step is idempotent, so
re-running `pnpm dev:deps` is safe, including after it was killed mid-bootstrap.

| Command | Does |
|---|---|
| `pnpm dev:deps` | Ordered bring-up above. |
| `pnpm dev:deps:obs` | The same, plus `--profile obs` (DEVENV-009). |
| `pnpm dev:deps:reset --yes` | `down -v` (drops every volume of the shared stack and `.bw-dev/openbao`), then the full bring-up. |
| `pnpm dev:doctor` | `.env` keys missing or empty versus `.env.example`, the health of every service and bootstrap job, and the loopback endpoints. Names and URLs only, never values. Exit 0 healthy, 1 problems, 2 Docker unreachable. |
| `pnpm dev` | `pnpm dev:doctor`, then `turbo run dev --parallel` (apps with hot reload). |
| `node scripts/wait-for-health.mjs [--timeout s] [--one-shot job] svc…` | The health waiter on its own. |

Integration check (manual, on a host with no other user of the `bwdev` stack, because reset drops shared
volumes): `pnpm dev:deps && pnpm dev:doctor && pnpm dev:deps && pnpm dev:deps:reset --yes && pnpm dev:doctor`.
The unit tests (`scripts/dev-orchestrate.test.mjs`) cover the ordering, waiting, lock and failure paths against
a mocked compose.

## Troubleshooting

- **Token validation fails with `iat`/`exp`/`nbf` errors (clock skew):** containers share the host kernel clock, so
  the host clock is wrong. On WSL2 it drifts after sleep: run `sudo hwclock -s` (or restart WSL), and keep NTP on
  (`timedatectl set-ntp true`). `pnpm dev:keycloak:smoke` fails if a fresh token's `iat` is more than 60 s off.
- **Keycloak realm out of date** (it is imported only once per DB): `pnpm dev:keycloak:reset --yes`. This drops
  only the Keycloak database (all realm changes, sessions and users), not the app data.

- **Volume from an older schema** (init scripts only run on an empty volume, so role or extension changes need a
  fresh one): `pnpm dev:deps:reset --yes`, then `pnpm dev:deps`. This deletes all local data in the stack, and the
  stack is shared by every worktree on the host.
- **Slow host, service reported unhealthy:** check `docker compose ... logs <service>`. Neo4j's first start
  (plugin install, store creation) can take up to two minutes.
