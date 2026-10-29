# egress-gateway

Blackwing's scoped egress proxy, written in Go (CONTEXT_PACK §5, §6). It is the only
route from run sandboxes to targets: HTTP/1.1 + HTTPS (per-run CA, MITM), SOCKS5 and
scoped DNS. It enforces the signed authorisation envelope and request budgets,
captures evidence, and **fails closed** (CONTEXT_PACK §8.1, §8.2).

This directory holds the gateway chassis (FOUND-013 module skeleton, EGRESS-001
lifecycle): typed configuration, structured JSON logs, Prometheus metrics,
OpenTelemetry tracing, the management plane (`/healthz`, `/readyz`, `/metrics`) and a
graceful SIGTERM/SIGINT drain. It is **never ready** until a verified policy snapshot
is loaded (EGRESS-003) and no data-plane listener is registered yet, so all egress is
denied by construction. Proxy, policy, DNS and capture logic arrive with the EGRESS
epic through the hook points in `internal/server`.

The `package.json` and `src/` stub only make the directory a pnpm/Turborepo workspace
member (`@blackwing/egress-gateway`). Go tooling ignores them; the Go module is not
part of the JS workspace.

## Module

| Item | Value |
|---|---|
| Module path | `github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway` (matches the repository, so it resolves with `go get`) |
| Minimum Go (`go` line) | `1.26.0` |
| Toolchain pin (`toolchain` line) | `go1.26.10` |
| Core libraries (pinned, direct) | `elazarl/goproxy`, `things-go/go-socks5`, `miekg/dns`, `cedar-policy/cedar-go` |
| Test libraries | Go `testing` + `stretchr/testify` |

The four core libraries are pinned in `go.mod`/`go.sum` before any code uses them.
They are imported only by `internal/*/deps.go`, which compiles under the
`egressdeps` build tag (`make build`, `make test`, `make vet`, lint and gosec all
include it), so the versions are checked without linking the libraries into the
skeleton binary. Delete a `deps.go` file once real code imports its library.

## Layout

```
cmd/gateway          CLI: run | check-config | version | help
internal/obs         slog JSON logger, Prometheus metrics, OpenTelemetry, stopwatch
internal/server      lifecycle, management plane, readiness, hook interfaces
internal/config      environment loader (fail closed) and the Secret type
internal/identity    proxy identity parser (tc/role/sess/run + token), verifier contract, 407/SOCKS mapping
internal/proxy       HTTP(S) MITM + SOCKS5 listeners (EGRESS epic)
internal/scope       deterministic scope matcher (host/IP/CIDR/port/path/method), shared TS vectors
internal/policy      Cedar evaluation of the signed policy snapshot (EGRESS/POLICY)
internal/dnsresolve  scoped resolver, IP pinning, anti-rebinding (EGRESS epic)
internal/capture     evidence capture; capture failure blocks (EGRESS epic)
Makefile             build/test/lint/vet/tidy/run and friends
.golangci.yml        lint config shared by local runs and CI (CI-005)
Dockerfile           multi-arch, distroless, non-root image stub (DEVENV, CI-007)
```

## Make targets

Run from this directory; `make help` lists everything.

| Target | What it does |
|---|---|
| `make build` | checks the toolchain, compiles every package (with and without `egressdeps`) and writes a static binary to `bin/<os>_<arch>/egress-gateway`. Cross-compile with `make build GOOS=linux GOARCH=arm64`. |
| `make build-cross` | builds the container platforms `linux/amd64` and `linux/arm64`. |
| `make test` | `go test -race` with coverage (`bin/coverage.out`), then the tagged build. |
| `make vet` | `go vet ./...` with and without `egressdeps`. |
| `make lint` | `gofmt -l` check, `golangci-lint config verify` and `golangci-lint run` (govet, staticcheck, errcheck, gosec, revive, ineffassign, unused; gofmt and goimports formatters). |
| `make gosec` | the standalone `gosec` scanner over sources, tests and tagged files. |
| `make govulncheck` | `govulncheck` (pinned `GOVULNCHECK_VERSION`) over the module and the pinned standard library; fails on reachable vulnerabilities. Part of `make verify`. |
| `make check-dockerfile` | fails if the Dockerfile `GO_VERSION` differs from the `go.mod` toolchain pin. Part of `make verify`. |
| `make tidy` / `make tidy-check` | `go mod tidy`, or fail if it would change anything (plus `go mod verify`). |
| `make run` | builds and runs `egress-gateway run` with `BW_ENV=dev LOG_LEVEL=debug` (dev-only Makefile defaults). |
| `make tools` | installs the pinned `golangci-lint` (`GOLANGCI_LINT_VERSION`) and `gosec` (`GOSEC_VERSION`) and `govulncheck` into `bin/tools/`. Lint targets install them on first use. |
| `make verify` | everything CI runs, in order. |

### Toolchain pin

`go.mod` is the single source of truth. The Makefile exports
`GOTOOLCHAIN=<toolchain line>`, so the go command downloads and runs exactly the
pinned toolchain, and `make check-go` (a prerequisite of every target) fails when
`go version` differs from the pin. Offline, with only a newer local Go, run with
`GOTOOLCHAIN=local GO_VERSION_CHECK=minimum`, which only requires the `go` line.
The Dockerfile's `GO_VERSION` build argument must match the pin.

The developer tools need a newer Go to build than the service pin; they are built
with `TOOLS_GOTOOLCHAIN=auto` and still lint the module against the pinned toolchain.

## Configuration

Read once from the environment by `internal/config`. Any missing or invalid key makes
`run` and `check-config` exit `1` before any listener is bound, listing every bad key
with a reason and **never the value**. Required keys have no default and no default
weakens security.

| Key | Required | Values | Default |
|---|---|---|---|
| `BW_ENV` | yes | `dev`, `test`, `staging`, `production` | none |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` | `info` |
| `GATEWAY_MGMT_ADDR` | no | `host:port` (port 1..65535) | `:9090` |
| `GATEWAY_HTTP_PROXY_ADDR` | no | `host:port` | `:3128` |
| `GATEWAY_SOCKS_ADDR` | no | `host:port` | `:1080` |
| `GATEWAY_DNS_ADDR` | no | `host:port` | `:5353` |
| `POLICY_SNAPSHOT_PATH` | yes | path of the signed policy snapshot | none |
| `VALKEY_URL` | yes | `redis://`, `rediss://`, `valkey://`, `valkeys://` URL (stored as `Secret`) | none |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | collector base URL, `http(s)://host:port`, no credentials | unset: spans not exported |
| `GATEWAY_DRAIN_TIMEOUT` | no | Go duration in `(0, 5m]` | `10s` |
| `GATEWAY_READ_TIMEOUT` | no | Go duration in `(0, 5m]`; HTTP proxy request read timeout | `30s` |
| `GATEWAY_WRITE_TIMEOUT` | no | Go duration in `(0, 5m]`; HTTP proxy response write timeout | `60s` |
| `GATEWAY_IDLE_TIMEOUT` | no | Go duration in `(0, 5m]`; HTTP proxy idle keep-alive timeout | `90s` |
| `GATEWAY_MAX_HEADER_BYTES` | no | integer in `[1024, 1048576]`; HTTP proxy request header cap | `65536` |
| `GATEWAY_MITM_ENABLED` | no | `true` or `false`; hand allowed CONNECT tunnels to TLS interception (EGRESS-006) | `true` |

An optional key that is present but empty is rejected rather than defaulted. Two
listeners may not share a port on overlapping hosts, so the management plane can
never share a socket with a sandbox-facing data plane. In deployment
`GATEWAY_MGMT_ADDR` must be an internal interface address, never the sandbox-facing
one (the Helm chart sets it). Values that carry credentials are stored as
`config.Secret`, which renders `[REDACTED]` through every fmt verb, `slog`,
`encoding/json` and `MarshalText`. `Config.Hash()` is the SHA-256 config fingerprint
used in audit events; secret fields contribute only whether they are set.

`make run` supplies dev values: management `127.0.0.1:13129`, proxy
`127.0.0.1:13128`, SOCKS `127.0.0.1:11080`, DNS `127.0.0.1:15354`, Valkey
`redis://127.0.0.1:16379/0` and a snapshot path under `bin/dev/` that does not exist,
so the dev gateway stays not ready.

## Private-range scope (lab only, #880)

Blocked ranges stay blocked unless a scope rule explicitly includes the address (CONTEXT_PACK §8.2).
Loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`) and the metadata addresses are
**never** admitted, not even by a rule that names them. Any other private range needs a rule that the lab
gate (`internal/scope/lab.go`, `ParseLabRules`) admits: `BW_ENV` is `dev` or `test`, the lab asset passed the
dev attest path, and the rule's cidr sits inside a verified lab network that is itself private. The gateway
snapshot loader must use `ParseLabRules`, so a refused rule never loads. Dials are re-checked against the
pinned IP at connect time (`netguard.DialControl`), so a DNS answer that moves to another private address is
refused. A redirect that leaves the rule is out of scope (`proxy.RedirectInScope`). The TypeScript rule-creation
gate is `assertLabScope` in `@blackwing/contracts` and uses the same table.

## Management plane and readiness

The management plane is its own listener and mux; data planes never share it.

| Endpoint | Behaviour |
|---|---|
| `GET /healthz` | liveness: `200 {"status":"ok"}` while the process serves. |
| `GET /readyz` | `200` only when config is valid, a **verified** policy snapshot is loaded and Valkey answers `PING`; otherwise `503`. Body: `{"ready":bool,"reason":"...","checks":{"config":{...},"policy":{...},"valkey":{...}}}`. |
| `GET /metrics` | Prometheus exposition: `egress_build_info{version,commit}`, `egress_up`, `egress_ready`, the label-free `egress_not_ready_reason` code, Go and process collectors. |

Other methods get `405`. Reasons (and `egress_not_ready_reason` codes): `ready` 0,
`starting` 1, `policy_not_loaded` 2, `policy_unreadable` 3, `policy_unverified` 4,
`valkey_unreachable` 5, `shutting_down` 6. Readiness is re-checked every second while
ready and with capped exponential backoff (250 ms to 30 s) while not ready, so a
Valkey that is down at boot keeps the gateway fail closed until it appears.

The default policy provider only checks that the snapshot file is readable and
reports it `policy_unverified`; verification is EGRESS-003's job, so the default
build is never ready. The control API (EGRESS-013) mounts on the management plane via
`Gateway.HandleControl`.

### Hook points (`internal/server`)

| Interface | Owner | Default (fail closed) |
|---|---|---|
| `PolicyProvider` | EGRESS-003 | `SnapshotFileProvider` (never verified) |
| `BudgetStore` | EGRESS-004 | `ValkeyProbe` (RESP `AUTH`/`PING` only) |
| `Capturer` | capture issue | returns `ErrNotImplemented` |
| `SessionInjector` | session-injection issue | returns `ErrNotImplemented` |
| `DataPlane` | EGRESS-005/007/008 | none registered |
| `AuditSink` | audit wiring | `LogAuditSink` (component `audit`) |

A `DataPlane` is started at most once, and only after the gateway first becomes
ready; it receives a `Gate` and must deny every request while `Gate.Ready()` is
false (readiness can drop again, and is latched off during shutdown).

### Proxy identity (`internal/identity`, EGRESS-002)

Sandbox credentials are `tc_<uuidv7>[.role_<uuidv7>][.sess_<uuidv7>][.run_<uuidv7>]`
(username) and a short-lived per-session token (password), over HTTP
`Proxy-Authorization: Basic` (decoded once by `ParseProxyAuthorization`) or SOCKS5
RFC 1929 auth. `Parse` enforces the grammar (canonical lowercase UUIDv7, each
segment at most once, no unknown segments, at most 512 bytes per field, no control
or non-ASCII characters). `Authenticator.Authenticate` then calls a
`TokenVerifier` (the in-memory `StaticVerifier` today; Valkey/broker-backed with
EGRESS-010; nil means `UnavailableVerifier`) and re-checks the run/session/test-case
binding and expiry (`expires_at <= now` is expired) itself. Every failure is a deny:
`Middleware` answers `407` with `Proxy-Authenticate` before any upstream connection
and strips `Proxy-Authorization` on success; `SOCKSStatus` gives the RFC 1929
failure byte. A verifier error is `ErrTokenInvalid` (`verifier_unavailable`) and
increments `egress_identity_verifier_unavailable_total`. Denials increment
`egress_identity_rejected_total{reason}`, log `component=identity` with `run_id`,
`session_id`, `token_sha256_prefix` and `reason`, and emit the
`egress.identity_rejected` audit event. The token itself is never logged, audited or
printed (`String`/`LogValue` redact it); tokens are compared in constant time.

## Lifecycle

1. Load and validate config; on error exit `1` with nothing bound.
2. Span `gateway.startup`: bind the management listener (a port in use is a fatal
   error, exit `1`), serve it, set `egress_up 1`, emit the `gateway.started` audit
   event with the config hash.
3. Evaluate readiness asynchronously; start data planes on the first ready.
4. On SIGTERM/SIGINT: latch `shutting_down` (not ready), stop accepting new
   connections, drain in-flight management and data-plane work for up to
   `GATEWAY_DRAIN_TIMEOUT`, flush telemetry, set `egress_up 0`, emit
   `gateway.stopped`. A drain that exceeds the timeout closes the remaining
   connections and exits `1`.

**SIGKILL** cannot be handled: no drain happens and in-flight connections drop.
That is safe because the gateway fails closed: a dropped connection is a denied
request, never an unchecked one. Durations (startup, drain) use the monotonic clock,
so wall-clock skew never distorts them; log timestamps are wall-clock UTC.

## CLI and exit codes

```
egress-gateway run            start; blocks until SIGINT/SIGTERM
egress-gateway check-config   validate the environment and exit
egress-gateway version        print version, commit, Go version and platform
```

`0` success, `1` invalid configuration or runtime failure, `2` usage error (no
command, unknown command, unexpected arguments).

## Logging

`log/slog` JSON on stderr, one object per line, with `ts` (UTC, RFC 3339 with
milliseconds), `level`, `msg`, `service`, `version` and `component` (`bootstrap`,
`readiness`, `mgmt`, `audit`). Inside a run, `obs.WithRun` adds `run_id` and
`session_id`. Logs never carry secrets or request/response bodies; configuration is
logged through `Config.LogValue` (the Valkey URL renders `[REDACTED]`).

## Container image

```sh
docker build -t blackwing/egress-gateway:dev apps/egress-gateway
docker buildx build --platform linux/amd64,linux/arm64 apps/egress-gateway
```

Multi-stage: `golang:<pin>-bookworm` builds a static binary (`CGO_ENABLED=0`,
`-trimpath`, `GOTOOLCHAIN=local`) for the target platform, and the runtime image is
`gcr.io/distroless/static-debian12:nonroot` with entrypoint `/egress-gateway run`.
The image exposes the management port 9090; data-plane ports arrive with the
listener issues (dev ports: proxy 13128, management 13129).

### Scope matcher (`internal/scope`, EGRESS-004)

`scope.ParseRules` parses and canonicalises an ordered include/exclude rule set (same JSON and
canonical forms as `parseScopeRules` in `@blackwing/contracts`); `scope.Match(target, rules)`
returns `Decision{Allow, MatchedRule, MatchedRuleIndex, Reason}`. Default deny, most specific rule
wins, exclude beats include on a tie, a host rule never authorises resolved IPs. The Go tests run
`packages/contracts/src/scope.vectors.json`, the same file `matchScope` (`@blackwing/domain`) runs
in Vitest, so the two implementations cannot drift. Callers count each evaluation with
`obs.Metrics.ObserveScope` (`egress_scope_eval_total{result}`) and log `Reason` and `MatchedRule`
(never the query string).
