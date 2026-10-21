# Kubernetes NetworkPolicies (INFRA-011)

Structural enforcement of CONTEXT_PACK §4.1 and §8.2 / §8.6: a sandbox pod reaches exactly
three destinations, and nothing in the platform is reachable except through explicit allows.

| File | Purpose |
|---|---|
| `00-default-deny.yaml` | `default-deny-all` (ingress + egress) in `bw-system` and `sandbox`. Applied first. |
| `10-bw-system-apps.yaml` | Per-app allows (api, worker, web, gateways, session-manager, sandbox-controller, postgres, valkey, temporal, keycloak, openbao) plus DNS to kube-dns. |
| `20-run-broker.yaml` | Run Broker API (api / run-broker, 13400) accepts ingress from sandbox pods only. |
| `30-sandbox.yaml` | Sandbox egress: egress-gateway 13128, model-gateway 13500, broker 13400, kube-dns 53. No ipBlock. |
| `run-isolation.template.yaml` | Per-run policy (same `blackwing.io/run` only); `apply.sh --render-run <id>`. |
| `calico/` | Pinned Calico CNI (`versions.env`), explicit Deny of `169.254.0.0/16`, `fd00:ec2::254`, link-local and all IPv6 for sandboxes. |
| `verify.sh` | Live probes against a cluster, with `--regression` fail-closed guard. |

Sandbox pods carry `blackwing.io/component=sandbox` and `blackwing.io/run=<runId>`. A pod
with a missing or mistyped label matches no allow, so default-deny applies (fail closed).

## CNI

Plain flannel does not enforce NetworkPolicy. Cloud (EC2) k3s nodes use Calico `v3.30.3`
(pinned in `calico/versions.env`): start k3s with `flannel-backend: none` and
`disable-network-policy: true`, then run `calico/install.sh`. The dev host keeps
flannel plus k3s' embedded kube-router controller (`../host/config.yaml`), which enforces
the same policies; `verify.sh` proves it with real denies. The cloud switch is tracked in
the "Port to online: Calico CNI on EC2 k3s nodes" porting issue.

## Notes

- Port numbers follow the dev port map; the gateways keep their Service names across dev and cloud.
- DNS is allowed to kube-dns only. Target name resolution for tests goes through the egress
  gateway's scoped resolver, never pod DNS.
- Kill switch: blocking at the egress gateway is the primary control; these policies are the
  structural backstop and make the chokepoint explicit.
- Observability: Calico flow logs record denied connections; the `SandboxDeniedEgress` rule
  in `prometheus-rules.yaml` alerts on non-zero denied sandbox egress.
- Offline coverage: `scripts/k3s-network-policies.test.mjs` evaluates the manifests with a
  NetworkPolicy semantics model (allowed three, denied internet/metadata/cross-run/mislabeled,
  removal of a policy detected).
