# ADR-0008: Route all target traffic through a fail-closed egress gateway written in Go

Date: 2026-10-20

## Status

Accepted

## Context

Agents run arbitrary tools (Bash, browsers, scanners) against customer assets. The only way to guarantee that
traffic stays inside the signed, approved scope, within budget and stoppable by the kill switch, is to enforce
it on the network path itself, outside the sandbox and independent of the model. The enforcement point
terminates TLS, speaks HTTP(S), SOCKS5 and DNS, handles high connection counts and must have a small, auditable
attack surface.

## Decision

- Target traffic leaves a sandbox **only through the egress gateway** (`apps/egress-gateway`), a **Go** service
  built on `elazarl/goproxy` (HTTP/1.1 and HTTPS MITM with a per-run CA), `things-go/go-socks5` (TCP),
  `miekg/dns` (scoped DNS) and `cedar-go` ([ADR-0007](0007-cedar-policy-decision-point.md)).
- Each run is an identity on the shared gateway; proxy credentials encode run, session, test case and role,
  which is how budgets, capture and role-session injection are applied.
- **The gateway fails closed.** No target traffic without a valid, unexpired, signature-verified envelope,
  re-verified on load and on every policy refresh. If it cannot evaluate policy, reach its configuration or
  write capture, it blocks. Redirects and DNS answers to out-of-scope destinations are blocked (resolve once,
  pin the IP, re-check), and private, link-local and metadata ranges are blocked unless explicitly in scope.
- On a kill the gateway blocks first, before sandboxes are terminated.

## Consequences

- Scope, budgets, capture and kill do not depend on agent or tool cooperation; tools that ignore proxy settings
  are forced through it and anything else is denied by network policy.
- An unavailable or misconfigured gateway stops testing rather than leaking traffic; availability is traded for
  safety on purpose.
- The repository carries a second language and toolchain, and Cedar evaluation must stay in agreement with the
  TypeScript side through the shared test vectors.

## References

- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "Languages" and "Egress gateway".
- [Context Pack §3.1 Layers](../architecture/CONTEXT_PACK.md#31-layers-from-the-component-diagram-and-where-each-lives):
  row "Scoped Egress Proxy".
- [Context Pack §4.1 Topology](../architecture/CONTEXT_PACK.md#41-topology): sandbox egress destinations and
  proxy credentials.
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.1 (valid envelope), §8.2 (egress fails closed) and §8.5 (kill switch blocks at the gateway first).
