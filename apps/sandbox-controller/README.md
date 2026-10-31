# @blackwing/sandbox-controller

Creates and destroys per-run sandboxes, run networks and CA material (CONTEXT_PACK §3.1, §6). It is called
by the Run Controller (`apps/worker`) over the internal control-plane network and is never reachable from a
sandbox. SANDBOX-001 (#448) is the chassis: config, server, auth, readiness, metrics, shutdown. Drivers
(SANDBOX-003/004), the spec builder (SANDBOX-007) and lifecycle routes (SANDBOX-010) plug into it.

## Run

```sh
pnpm --filter sandbox-controller start      # tsx src/main.ts, reads the environment below
pnpm --filter sandbox-controller test       # unit
pnpm --filter sandbox-controller test:int   # Testcontainers Valkey + real process
```

## Configuration

| Key                                                    | Default      | Notes                                                                                              |
| ------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------- |
| `SBX_MGMT_ADDR`                                        | `:7070`      | `host:port`; empty host = every interface of the controller pod. Dev: `127.0.0.1:13700`.           |
| `SBX_DRIVER`                                           | `kubernetes` | `kubernetes` or `docker`.                                                                          |
| `SBX_NAMESPACE`                                        | `bw-runs`    | RFC 1123 label.                                                                                    |
| `SBX_NETPOL_ENFORCER`                                  | unset        | `calico`, `cilium` or `kube-router`: the CNI that enforces NetworkPolicy. Unset refuses run networks (`SBX_NETPOL_UNSUPPORTED`). |
| `SBX_RUNTIME_CLASS`                                    | `gvisor`     | RFC 1123 label.                                                                                    |
| `SBX_IMAGE_DIGEST`                                     | required     | Must be pinned `@sha256:` (§8.9); tags are refused.                                                |
| `SBX_TTL_SECONDS`                                      | `3600`       | 1 to 86400.                                                                                        |
| `SBX_CPU`                                              | `1`          | Default CPU cores per sandbox (fractional, up to 16). Requests above the plan ceiling are clamped. |
| `SBX_MEM_MIB`                                          | `2048`       | Default memory per sandbox. Deep-tier personas get 4096 unless the request says otherwise.         |
| `SBX_PIDS`                                             | `512`        | Default process limit per sandbox.                                                                 |
| `SBX_WORKSPACE_MIB`                                    | `1024`       | `/workspace` tmpfs size. Zero is refused.                                                          |
| `SBX_DRAIN_TIMEOUT`                                    | `10s`        | Drain budget on SIGTERM/SIGINT.                                                                    |
| `SBX_MAX_BODY_BYTES`                                   | `1048576`    | Larger bodies get 400 `SBX_BAD_REQUEST`.                                                           |
| `SBX_RUN_TOKEN_SECRET`                                 | required     | HMAC key for `bw_run_` tokens, at least 32 characters. Secret.                                     |
| `VALKEY_URL`                                           | required     | `redis://` or `rediss://`. Secret.                                                                 |
| `SBX_INPUTS_MAX_MIB`                                   | `256`        | Cap on a run's spec objects staged under `/inputs`. Larger: `SBX_INPUT_TOO_LARGE`.                  |
| `SBX_SRC_MAX_MIB`                                      | `1024`       | Cap on the shallow source checkout staged under `/src`. Larger: `SBX_INPUT_TOO_LARGE`.             |
| `SBX_INPUTS_BUCKET`                                    | `bw-inputs`  | Bucket of uploaded spec objects (MinIO locally, S3 online). Keys are tenant-prefixed.              |
| `SBX_STAGING_DIR`                                      | `/var/lib/blackwing/staging` | Controller-local root of per-run staging dirs. Absolute path. Wiped on teardown.   |
| `SBX_BUILD_COMMIT`                                     | `unknown`    | Reported by `sbx_build_info`.                                                                      |
| `NODE_ENV`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` |              | From the shared base schema.                                                                       |

Invalid configuration prints `SBX_CONFIG_INVALID: <keys and reasons>` (never values) to stderr and exits
78 before any socket is bound.

## HTTP surface

- `GET /healthz`: liveness, always 200 while the process serves.
- `GET /readyz`: 200 only when the driver and Valkey answered their latest probe. Failing probes retry
  with exponential backoff (250 ms doubling to 30 s), and healthy ones are re-probed every 5 s. The default
  build has no driver yet, so it stays 503 (fail closed).
- `GET /metrics`: Prometheus. `sbx_up`, `sbx_ready`, `sbx_build_info{version,commit}`,
  `sbx_auth_failures_total{reason}`.
- `/internal/sandboxes/*`: requires `Authorization: Bearer bw_run_<payload>.<sig>`. The check runs before
  routing and body parsing. Missing, invalid, forged, expired or wrong-audience tokens all get the same
  401 problem+json `SBX_UNAUTHENTICATED`. Handlers read `request.runContext` (`tenantId`, `runId`).
  Malformed or oversized JSON gets 400 problem+json `SBX_BAD_REQUEST`.

### Run-scoped token

`bw_run_` + base64url(JSON `{v:1, aud, tid, rid, iat, exp}`) + `.` + base64url(HMAC-SHA256(key,
`bw_run_` + payload)). `aud` must be `sandbox-controller`, so a token minted for another internal
service is refused. `signRunToken` is the issuer helper. Tokens are redacted from every log line by the
shared `run-token` pattern.

## Shutdown

SIGTERM/SIGINT marks the process not ready, stops accepting connections and drains in-flight requests
for up to `SBX_DRAIN_TIMEOUT`. During the drain each response closes its connection. After the timeout the
remaining connections are cut and the process exits 1, otherwise it exits 0. It then emits
`sandbox_controller.stopped` and flushes telemetry. SIGKILL skips the drain. Creates must therefore be
idempotent (SANDBOX-010).

## Audit and logs

`sandbox_controller.started`/`stopped` carry a SHA-256 config hash. Secret keys count only as present,
never by value. Until the `@blackwing/audit` emitter (#82) lands they are written as structured `audit`
log lines. Logs are pino JSON via `@blackwing/logger`, with `component`, and on internal requests also
`tenant_id`, `run_id` and `sandbox_id`.

## Drivers

`src/drivers/driver.ts` defines `SandboxDriver`, the one interface KubernetesDriver (SANDBOX-003) and
DockerDriver (SANDBOX-004) implement; `SBX_DRIVER` picks one without touching call sites. Its data contracts
(`SandboxSpec`, `RunNetworkSpec`, `SandboxHandle`, `SandboxLifecycleEvent`, `MountSpec`, ...) are Zod schemas in
`@blackwing/contracts` (`packages/contracts/src/sandbox.ts`):

- every spec carries `tenantId` and `runId`, and `list` always filters by tenant (§8.6);
- `imageDigest` must be digest-pinned and `runtimeClass` is recorded (§8.9);
- non-tmpfs mounts are read-only (type and parse enforced), mount targets are unique;
- a run network with no allowed destination is rejected (fail closed);
- `caBundleRef` is a `<scheme>://` reference and PEM material is refused anywhere in the spec (§8.7).

`KubernetesDriver` (`drivers/kubernetes.ts`, SANDBOX-003) renders each sandbox as a Pod in `SBX_NAMESPACE` under
the RuntimeClass named by the spec (`gvisor`), with `@kubernetes/client-node` (in-cluster service account, or the
kubeconfig in dev). The manifest (`drivers/kubernetes-config.ts`) is a pure function: digest-pinned image,
`automountServiceAccountToken: false`, `restartPolicy: Never`, secret or configmap inputs only,
`activeDeadlineSeconds` = TTL. Its security context, resource limits and `/workspace` and `/tmp` tmpfs volumes come
from the SANDBOX-007 builder (`spec/hardening.ts`), and any spec tmpfs is capped to the resolved workspace size. The RuntimeClass must resolve
to the `runsc` handler, or create fails with SBX_RUNTIME_MISSING. Pods are created behind a scheduling gate that
`start` removes. A container that cannot be created (for example a missing seccomp profile) is reported as `failed`. Creating the same sandbox twice returns one Pod. Transient API failures retry with jittered backoff,
and anything else surfaces as SBX_DRIVER_UNAVAILABLE. Run networks (`net/`, SANDBOX-005) give each run two NetworkPolicies in `SBX_NAMESPACE`, selecting its pods by
`bw/run-id`: a default-deny for ingress and egress, and an egress allow to exactly the declared destinations
(egress gateway, model gateway and Run Broker, each as a pod selector in `bw-system` on its port) plus kube-dns on 53.
The policies are positive-only (no `ipBlock`), so the metadata endpoint and private ranges stay denied. Creating a
sandbox first checks that both policies exist and belong to its tenant (`SBX_NETWORK_UNAVAILABLE` otherwise), so a
partly applied network blocks creation. `removeNetwork` refuses while the run still has pods and is idempotent.
Audit lines `run_network.created` and `run_network.destroyed` and the `sbx_netpol_apply_total{result}` counter record
each transition. The controller cannot probe the CNI, so `SBX_NETPOL_ENFORCER` declares the enforcer; the live
connectivity matrix is proven by `infra/k3s/network-policies/verify.sh` on a cluster.

`FakeDriver` is an in-memory implementation for controller unit tests. `UnavailableDriver` is a fail-closed stand-in
for a kind this build does not ship. The factory no longer uses it, since both shipped kinds are real drivers.

The integration test (`drivers/kubernetes.int.test.ts`) runs against a real k3s cluster with the gVisor RuntimeClass
when `SBX_IT=1`, and is skipped otherwise.

## Run inputs (INGEST / #456)

`src/inputs/` stages a run's inputs before any sandbox starts. `stageRunInputs` reads the run's input manifest,
fetches each spec object by key from object storage, and verifies its size and sha256 against the manifest.
A source repository is shallow-checked out (`git init`, `fetch --depth 1`, detached checkout) with its deploy token
resolved from `@blackwing/secrets` by reference. The token travels only in the git child's `http.extraHeader`.

- **Mounts:** `stagedInputMounts` returns read-only `inputs` at `/inputs` and `source` at `/src` (`file://` refs,
  bound `:ro` by the Docker driver). The Kubernetes driver refuses them until #913.
- **Fail closed:** missing object, size or sha256 mismatch, or an unsafe name -> `SBX_INPUT_INTEGRITY_FAILED`.
  Oversize -> `SBX_INPUT_TOO_LARGE`. Auth refused -> `SBX_SOURCE_AUTH_FAILED`. A symlink that resolves outside
  `/src` -> `SBX_SOURCE_SYMLINK_ESCAPE`. Every failure removes the run's staging dir, so no partial mount exists.
- **Credentials:** the checkout's `.git/config` holds the bare URL only, and `stripGitConfigCredentials` removes any
  userinfo or `extraheader` that appears. Repository URLs must be `https:` with no userinfo.
- **Audit and metrics:** `inputs.staged` (object keys, bytes) and `source.checked_out` (credential-free URL and ref)
  go out as `audit` log lines. Counters: `sbx_inputs_staged_total{result}`, `sbx_source_bytes`.

Tests: `src/inputs/*.test.ts` (unit, real git against a local repository), and `src/inputs/stage.int.test.ts`
(real MinIO via Testcontainers). Run the integration test with `pnpm --filter sandbox-controller test:int`.

## Run CA (SANDBOX-008)

`src/ca/` issues one MITM CA per run, shared by every sandbox of that run (`createRunCaProvisioner`, the
`CaProvisioner` port in `drivers/types.ts`).

- **Certificate:** ECDSA P-256, self-signed, `CN=Blackwing Run <runId>`, `basicConstraints CA:TRUE, pathlen:0`,
  keyCertSign and cRLSign. `notBefore` is backdated 60 s for clock skew. `notAfter` is the run window end plus
  5 min grace, capped at the standing-authorisation expiry (§8.1).
- **Key:** written once (`cas: 0`) to OpenBao KV v2 at `secret/data/tenants/<tenant>/runs/<run>/run-ca/key`,
  under the AppRole `bw-run-ca` (`infra/compose/openbao/policies/bw-run-ca.hcl`, one segment per tenant and run).
  Only an `openbao://` reference leaves the provisioner (`keyRef`). The key is never returned, logged or put in a spec.
- **Certificate:** stored beside the key at `.../run-ca/cert`. `caBundleRef` points there, and that is the only
  CA material a sandbox sees.
- **Issue:** idempotent per run (a second call returns the same CA). Concurrent calls in one process share one
  issuance. The key is created first, and any later failure rolls the run back (deletes both records and withdraws
  the run), so an unaudited or unpublished CA never stays live. An unreachable store fails closed.
- **Publish:** the certificate and its `sha256:` fingerprint go to the egress gateway through `EgressCaRegistry`.
  The shipped implementation is `createInMemoryEgressCaRegistry` (process-local). The control-plane wire format
  is EGRESS-006's; the gateway never receives a key.
- **Revoke:** `revokeRunCa` deletes both KV metadata entries (later reads 404) and withdraws the run. It is
  idempotent and audits `run_ca.revoked` only when a CA existed. Run end and kill call it. SANDBOX-010 wires those calls.
- **Sandbox trust:** `caTrustFragment(caBundleRef)` returns the `SandboxSpec` fragment: a read-only `ca` mount at
  `/etc/bw/ca.pem` and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`. The contract
  rejects PEM in `caBundleRef` and in env.
- **Audit and metrics:** `run_ca.issued` (`tenantId`, `runId`, `fingerprintSha256`, `notAfter`) and `run_ca.revoked`
  are emitted as structured `audit` log lines until the `@blackwing/audit` outbox (#82) replaces them. Counters:
  `sbx_ca_issued_total`, `sbx_ca_revoked_total`.

Tests: `src/ca/*.test.ts` (unit, with an in-memory KV fake) and `src/ca/run-ca.int.test.ts` (real OpenBao via
Testcontainers, plus a stub HTTPS gateway whose certificate the run CA signed. A child Node process trusts it only
through the injected `NODE_EXTRA_CA_CERTS`). Run them with `pnpm --filter sandbox-controller test:int`.
