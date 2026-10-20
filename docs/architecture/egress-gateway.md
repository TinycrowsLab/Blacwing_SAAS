# Egress gateway chassis

The egress gateway (`apps/egress-gateway`, Go) is the only route from run sandboxes to
targets ([CONTEXT_PACK §4.1](CONTEXT_PACK.md#41-topology)). EGRESS-001 (#186) builds
its chassis; the operational reference (configuration keys, endpoints, metrics, hook
points, lifecycle) lives in [`apps/egress-gateway/README.md`](../../apps/egress-gateway/README.md).

## Planes

| Plane | Listener | Contents |
|---|---|---|
| Management | `GATEWAY_MGMT_ADDR` (internal interface only) | `/healthz`, `/readyz`, `/metrics`, control API mount (EGRESS-013) |
| Data | `GATEWAY_HTTP_PROXY_ADDR`, `GATEWAY_SOCKS_ADDR`, `GATEWAY_DNS_ADDR` (sandbox-facing) | proxy, SOCKS5 and DNS listeners (EGRESS-005/007/008) |

The planes never share a listener or a mux, and config validation rejects
overlapping addresses.

## Fail-closed readiness ([§8.2](CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch))

`ready` is true only when the config is valid, a signature-verified policy snapshot
is loaded (EGRESS-003) and Valkey is reachable. Data planes bind only after the first
transition to ready and must deny every request whenever readiness drops, including
during shutdown. Until EGRESS-003 lands the default policy provider never reports a
verified snapshot, so the gateway denies all egress.

## Lifecycle

Config load (invalid: exit 1, nothing bound) → span `gateway.startup`, bind the
management plane (port in use: exit 1) → `gateway.started` audit event with the
config hash → asynchronous readiness checks with backoff → on SIGTERM/SIGINT latch
not ready, drain within `GATEWAY_DRAIN_TIMEOUT`, flush telemetry, `gateway.stopped`.
SIGKILL drops in-flight connections, which is safe because a dropped connection is a
denied request.
