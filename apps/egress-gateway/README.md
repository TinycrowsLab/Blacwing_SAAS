# egress-gateway

Blackwing's scoped egress proxy, written in Go (CONTEXT_PACK §5, §6). It is the only
route from run sandboxes to targets: HTTP/1.1 + HTTPS (per-run CA, MITM), SOCKS5 and
scoped DNS. It enforces the signed authorisation envelope and request budgets,
captures evidence, and **fails closed** (CONTEXT_PACK §8.1, §8.2).

This directory holds the Go module skeleton (FOUND-013). The skeleton validates
configuration, logs structured JSON and handles SIGINT/SIGTERM, but it **binds no
listener**, so all egress is denied by construction. Proxy, policy, DNS and capture
logic arrive with the EGRESS epic.

The `package.json` and `src/` stub only make the directory a pnpm/Turborepo workspace
member (`@blackwing/egress-gateway`). Go tooling ignores them; the Go module is not
part of the JS workspace.

## Module

| Item | Value |
|---|---|
| Module path | `github.com/TinycrowsLab/Blacwing_SAAS/apps/egress-gateway` (matches the repository, so it resolves with `go get`) |
| Minimum Go (`go` line) | `1.23.0` |
| Toolchain pin (`toolchain` line) | `go1.23.12` |
| Core libraries (pinned, direct) | `elazarl/goproxy`, `things-go/go-socks5`, `miekg/dns`, `cedar-policy/cedar-go` |
| Test libraries | Go `testing` + `stretchr/testify` |

The four core libraries are pinned in `go.mod`/`go.sum` before any code uses them.
They are imported only by `internal/*/deps.go`, which compiles under the
`egressdeps` build tag (`make build`, `make test`, `make vet`, lint and gosec all
include it), so the versions are checked without linking the libraries into the
skeleton binary. Delete a `deps.go` file once real code imports its library.

## Layout

```
main.go              minimal CLI: run | check-config | version | help
internal/config      environment loader (fail closed) and the Secret type
internal/proxy       HTTP(S) MITM + SOCKS5 listeners (EGRESS epic)
internal/policy      Cedar evaluation of the signed policy snapshot (EGRESS/POLICY)
internal/dns         scoped resolver, IP pinning, anti-rebinding (EGRESS epic)
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
| `make tidy` / `make tidy-check` | `go mod tidy`, or fail if it would change anything (plus `go mod verify`). |
| `make run` | builds and runs `egress-gateway run` with `BW_ENV=dev LOG_LEVEL=debug` (dev-only Makefile defaults). |
| `make tools` | installs the pinned `golangci-lint` (`GOLANGCI_LINT_VERSION`) and `gosec` (`GOSEC_VERSION`) into `bin/tools/`. Lint targets install them on first use. |
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
`run` and `check-config` exit `1` before anything starts, listing every bad key with a
reason and **never the value**. There is no default for a required key and no default
weakens security.

| Key | Required | Values | Default |
|---|---|---|---|
| `BW_ENV` | yes | `dev`, `test`, `staging`, `production` | none |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error` | `info` when unset; an empty value is rejected |

Enum values tolerate surrounding whitespace and are case-sensitive. Values that carry
credentials (added by later issues) must be stored as `config.Secret`, which renders
`[REDACTED]` through every fmt verb, `slog`, `encoding/json` and `MarshalText`.

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
milliseconds), `level`, `msg`, `service`, `version` and `component`. The field
names follow the EGRESS logging contract and will line up with the OpenTelemetry
log data model when telemetry is wired in. Configuration is logged as keys and
non-secret values only.

## Container image

```sh
docker build -t blackwing/egress-gateway:dev apps/egress-gateway
docker buildx build --platform linux/amd64,linux/arm64 apps/egress-gateway
```

Multi-stage: `golang:<pin>-bookworm` builds a static binary (`CGO_ENABLED=0`,
`-trimpath`, `GOTOOLCHAIN=local`) for the target platform, and the runtime image is
`gcr.io/distroless/static-debian12:nonroot` with entrypoint `/egress-gateway run`.
No port is exposed until the EGRESS epic adds listeners (dev ports: proxy 13128,
management 13129).
