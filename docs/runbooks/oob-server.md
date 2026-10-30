# Runbook: out-of-band listener, interactsh-server (INFRA-010)

Files: `infra/helm/bw-oob/` (the pinned server, its ConfigMap, ClusterIP Service, wildcard Certificate and
NetworkPolicy), `infra/compose/docker-compose.dev.yml` (`interactsh`, the same pinned digest, for local work),
`infra/tofu/modules/dns` (delegation, `oob_server_ips`; see `dns-delegation.md`). Self-tests:
`node --test scripts/oob-server.test.mjs` (offline, `helm template`) and
`node --test scripts/oob-server.int.mjs` (local, needs docker; `pnpm test:oob-server`).

The listener is the OAST oracle for blind-vulnerability confirmation (CONTEXT_PACK §5, §7). Blackwing owns it: no
public collaborator is used. Sandboxes never reach it; specialists use the OOB MCP tools through the broker (OOB-006).

## What runs

| Item | Value |
|---|---|
| Image | `projectdiscovery/interactsh-server:v1.2.4@sha256:ffde50de…` (MIT). The digest is the one in `docker-compose.dev.yml`, and `scripts/oob-server.test.mjs` fails if they differ. |
| Process | uid 65532, read-only root filesystem, all capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp, no service-account token. |
| Listeners | DNS 53 (UDP and TCP), HTTP 80, HTTPS 443, SMTP 25 on the node's public address (`hostPort`). The container binds 5353, 8080, 8443 and 2525. |
| Zone | `oob.<domain>`, answered with `-ip <publicIP>`. The delegation comes from the app zone (dns module). |
| TLS | Wildcard `*.oob.<domain>` and apex, issued by cert-manager (DNS-01 through the bw-ingress ClusterIssuer), passed with `-cert` and `-privkey`. ACME is not used, so the server makes no outbound connection. |
| Control API | The poll and register API, token-gated (`-token` from Secret `existingSecret`, key `token`). Exposed as a ClusterIP Service for `bw-system` only. |
| State | In memory, evicted after `eviction` days. Persistence is OOB-004, not this server. Restarting loses unpolled interactions; the client polls often. |
| Replicas | 1, `Recreate` strategy. Host ports and the in-memory store both forbid a second copy on the same address. |

## Install (real cluster, after the dns module is applied)

1. Pick a node for the listener. Label and taint it, so that the Traefik host ports (80/443) are never on it:
   `kubectl label node <node> blackwing.io/oob=true` and
   `kubectl taint node <node> blackwing.io/oob=true:NoSchedule`. One release per public address, each on its own node.
2. Create the namespace: `kubectl create namespace bw-oob` and
   `kubectl label namespace bw-oob pod-security.kubernetes.io/enforce=baseline`. The `restricted` profile forbids
   `hostPort`. The pods still run as non-root, read-only and without capabilities; the chart enforces that.
3. Sync the token from OpenBao into Secret `bw-oob-token` (key `token`) in `bw-oob`. Never put the token in values,
   git or a shell history.
4. Install:
   `helm upgrade --install bw-oob infra/helm/bw-oob -n bw-oob --set domain=<domain> --set publicIP=<tofu oob_server_ips entry>`.
   The chart refuses to render without a domain, a public IPv4 address (private, loopback, link-local, CGNAT and
   multicast are rejected), the token Secret, an image digest and the dedicated-node selector.
5. Set the second address in `oob_server_ips` if you run two servers, then apply tofu, as `dns-delegation.md`
   describes.

## Validation

Offline (CI and any machine): `node --test scripts/oob-server.test.mjs` and `pnpm test:oob-server` (docker).

Live, after install (staging first, then prod):

1. `kubectl -n bw-oob get pods` shows `Running`, `1/1`, and the readiness probe passes.
2. `dig NS oob.<domain> +short` returns `ns1.<domain>` and `ns2.<domain>` (see `dns-delegation.md`).
3. `dig A $(openssl rand -hex 6).oob.<domain> +short @<publicIP>` returns `<publicIP>`, and
   `dig A $(openssl rand -hex 6).oob.<domain> +short` returns it through the delegation.
4. `curl -sS -o /dev/null -w '%{http_code}\n' https://$(openssl rand -hex 6).oob.<domain>/` returns `200` with a
   certificate that validates (`curl -v` shows `SSL certificate verify ok`). Use `letsencrypt-staging` first. The
   staging CA is not trusted by curl, so use `--cacert` with the staging chain while proving the server.
5. `curl -sS -o /dev/null -w '%{http_code}\n' "https://oob.<domain>/poll?id=x&secret=y"` returns `401` without the token.
6. From a sandbox pod, `curl --max-time 5 http://<publicIP>/` and `curl --max-time 5 http://bw-oob.bw-oob.svc:8080/`
   both fail (the cluster CIDRs and the sandbox policy deny them).

Each step must pass before the release is called live. Record the result and the image digest in the deploy note.

## Failure modes

| Symptom | Cause and action |
|---|---|
| Health check fails right after install | Pod not ready, or the Secret or certificate is missing. `kubectl -n bw-oob describe pod`. The cert-manager `Certificate` must be `Ready`. |
| `dig NS oob.<domain>` is empty | Delegation not live or not propagated. Check the registrar step in `dns-delegation.md`. The listener answers nothing until then. |
| Certificate stays not Ready | DNS-01 failed on Route53 (solver credentials or `hostedZoneID`). HTTP and DNS still work, but HTTPS and SMTPS are degraded. Raise an alarm and fix the solver. |
| Pod stuck `Pending` | No node carries `blackwing.io/oob=true`, or the host port 80/443/53/25 is taken on that node (Traefik or another service). Move the listener to a clean node. |
| Pod restarts after `CreateContainerConfigError` | The Secret `bw-oob-token` is missing or the key is not `token`. |
| Server log shows ACME attempts | The custom certificate was not read. Check the Secret mount at `/tls`. The server must not contact Let's Encrypt. |

## Rules to keep it working

- Never add a record at or below `oob.<domain>` in the app zone (see `dns-delegation.md`).
- Never allow the sandbox egress policy to reach this namespace. The cluster CIDRs are excluded from the public rule,
  so a sandbox pod is blocked from the listener and from the poll API.
- The poll API shares the public HTTP listener and is token-gated. The token is the only control; rotate it through
  OpenBao, then restart the pod. The token is visible in the container's process arguments inside the pod, so limit
  `kubectl exec` access to the platform team.
- Bump the image digest and `appVersion` together. Renovate proposes the digest; the chart test fails until the
  compose pin is updated in the same change.
- Do not change `-ip`, the zone or the certificate names without also changing the delegation (`dns-delegation.md`).

## Rollback

`helm rollback bw-oob <revision> -n bw-oob`. The previous digest is restored; interactions held in memory are lost
on restart (see the state row above). Do not delete the namespace: it holds the token Secret synced from OpenBao.

## Open items (porting issue #910)

The following are not verified offline and move to the online-porting issue (#910): applying the chart to a real dedicated
node, the live delegation and certificate issuance, the Prometheus/Loki wiring (metrics `oob_server_up` and
interaction counts), the `oob_server.deployed` audit event (version and domain, written by the control plane when
the release is recorded), and the sandbox-to-listener check run from a real sandbox pod.
