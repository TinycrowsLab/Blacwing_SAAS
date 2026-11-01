# bw-deps: third-party dependencies (INFRA-010)

The data, identity, workflow, secrets and observability backends that every Blackwing app talks to, as one
Helm release: PostgreSQL 16 + pgvector + pgcrypto, Valkey 8, Neo4j 5 Community, MinIO (S3), Temporal + UI,
Keycloak 26, OpenBao (raft, transit and KV v2), interactsh-server, and the `obs` profile (OpenTelemetry
Collector, Prometheus, Loki, Tempo, Grafana).

The images are the same digests the dev compose stack uses (`infra/compose/docker-compose.dev.yml`), and the
configs come from the same files, so dev, CI and the cluster run the same bits (CONTEXT_PACK §5, §8.9). The
`scripts/helm-deps.test.mjs` suite fails when either drifts.

## Install

Create the Secrets first (see the table below), then install into `bw-system`, the namespace the apps already
use. The `otel-collector.bw-system` endpoint in `infra/helm/blackwing` depends on that.

```sh
helm upgrade --install bw-deps infra/helm/bw-deps -n bw-system --atomic \
  -f infra/helm/bw-deps/values-prod.yaml \
  --set keycloak.publicUrl=https://id.<domain> \
  --set interactsh.advertiseIp=<public IP of the OOB Service>
```

Dev cluster (kind or k3s on the dev host):

```sh
helm upgrade --install bw-deps infra/helm/bw-deps -n bw-system -f infra/helm/bw-deps/values-dev.yaml
```

`global.environment` is required. The render fails closed when:

- an image is not pinned by a `@sha256:` digest;
- OpenBao has no TLS Secret, unless `openbao.allowPlaintext` is set (dev only);
- `keycloak.publicUrl` is empty in prod;
- the observability profile has no Grafana Secret.

No template renders a Secret. Every credential is a `secretKeyRef` with `optional: false`, so a missing Secret
stops the pod at creation.

## Secrets this release reads

| Secret (default name) | Keys | Used by |
|---|---|---|
| `bw-deps-postgres` | `superuser-password`, `app-password`, `migrator-password` | postgres, postgres-provision, temporal |
| `bw-deps-valkey` | `password` | valkey (`requirepass`) |
| `bw-deps-neo4j` | `auth` (the value `neo4j/<password>`, the `NEO4J_AUTH` form) | neo4j, neo4j-guard |
| `bw-deps-minio` | `root-user`, `root-password` | minio |
| `bw-deps-keycloak` | `admin-password`, `db-password` | keycloak, postgres-provision |
| `bw-deps-openbao` | `bootstrap-token` (may enable mounts only; never used by apps) | openbao-mounts |
| `bw-deps-openbao-tls` | `tls.crt`, `tls.key`, `ca.crt` (cert-manager, INFRA-012) | openbao listener |
| `bw-deps-interactsh` | `token` | interactsh |
| `bw-deps-grafana` | `admin-password` | grafana |

The names are `postgres.secretName`, `valkey.secretName` and so on in `values.yaml`. They are created by the
secret store (SECRETS epic), not by this chart.

## What runs, in order

| Step | Object | Notes |
|---|---|---|
| 1 | `postgres` StatefulSet | `max_connections`, WAL level and `archive_mode` set from values. Archiving stays `off` until INFRA-013. |
| 2 | `postgres-provision` Job (hook) | Idempotent: creates the `bw_app` and `bw_migrator` login roles and re-syncs their passwords, applies `roles.sql` (DB-001: owner, app, operator and relay roles, pgvector and pgcrypto), grants `bw_owner` to the migrator, and creates the Keycloak role and database. Runs on every upgrade. |
| 3 | `neo4j` StatefulSet and `neo4j-guard` Job (hook) | The Job installs the APOC `tenantId` guard and fails the release unless it proves the guard rejects an unscoped node. |
| 4 | `temporal` and `temporal-bootstrap` Job (hook) | The server creates and migrates its databases on start. The Job creates the `blackwing` namespace and the search attributes, and fails on a type conflict. |
| 5 | `keycloak` Deployment | `start --import-realm` imports `files/keycloak/realm-blackwing.json` on first boot. It skips an existing realm. |
| 6 | `openbao` StatefulSet and `openbao-mounts` Job (hook) | Raft storage, TLS on the listener. The Job enables `transit/` and `secret/` (KV v2). It waits up to ten minutes for the server to be unsealed. |
| 7 | `valkey`, `minio`, `interactsh` | Cluster-internal Services. |
| 8 | `obs` (when `obs.enabled`) | Collector, Prometheus, Loki, Tempo and Grafana with the provisioned datasources and the Blackwing dashboard. |

## Operator steps after the first install

OpenBao starts sealed. Initialise it once and unseal it with the keys (one share per key is the dev default).
Store the root token and the unseal keys in the secret store, never in git:

```sh
kubectl -n bw-system exec openbao-0 -- bao operator init -key-shares=5 -key-threshold=3
kubectl -n bw-system exec -it openbao-0 -- bao operator unseal   # run three times with three keys
```

Until the server is unsealed, the `openbao-mounts` Job waits and then fails, which makes the release fail
loudly. Re-run `helm upgrade` after unsealing. Auto-unseal with a cloud KMS is an online step.

## Storage and data loss

Every StatefulSet keeps its PVCs when it is deleted or scaled (`persistentVolumeClaimRetentionPolicy: Retain`).
The `gp3` StorageClass should use `reclaimPolicy: Retain` too, so a lost node does not delete the volume. Backups
(INFRA-013 for Postgres, INFRA-014 for the other stores) cover recovery; WAL archiving is enabled there.

## Tests

- `node --test scripts/helm-deps.test.mjs` (also run by `pnpm test:scripts`). It lints both overlays and renders
  them offline with `helm template`. It checks: every image is digest-pinned and identical to the compose
  stack's; no Secret is rendered; secret-like env vars come only from a `secretKeyRef`; every Service is
  ClusterIP; every long-running container has a readiness probe and no service-account token; StatefulSets
  retain their PVCs; the bootstrap steps are hooks; obs is gated; OpenBao is TLS-only outside dev; and every
  fail-closed guard refuses. It also checks that the copied sources match their owners byte for byte, including
  `packages/db/src/roles.sql`, and that the shell scripts parse. kubeconform runs when it is on the PATH.

### Not covered offline (integration half)

These need a real cluster and the published images. They are the remaining acceptance steps for INFRA-010:

- `helm install` on a kind or k3s cluster, with every pod Ready.
- `SELECT extname FROM pg_extension` shows `vector` and `pgcrypto`, and `bw_app` has `rolbypassrls = false`.
- A sample Temporal workflow registers in the `blackwing` namespace.
- Keycloak serves the imported realm, and the OpenBao `transit/` and `secret/` mounts are listed.
- Grafana shows the provisioned datasources and receives metrics.
- interactsh answers a wildcard query on the OOB zone.

The online pieces are tracked in the porting issue the `OFFLINE-STUB` markers point to: the public OOB zone and
DNS delegation (INFRA-007), ingress and TLS (INFRA-012), cloud KMS auto-unseal, HA for OpenBao and Keycloak, and
splitting the Temporal server from its admin tools.
