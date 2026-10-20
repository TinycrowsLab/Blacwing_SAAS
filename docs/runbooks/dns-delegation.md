# Runbook: application DNS zone and OOB delegation (INFRA-007)

Code: `infra/tofu/modules/dns`, called from each `infra/tofu/environments/<env>/dns.tf`.

## What exists

| Record | Where | Purpose |
|---|---|---|
| Public hosted zone `<domain>` | Route53 | Application zone. Zone id and ARN are outputs for INFRA-008 (SES) and INFRA-012 (TLS, ingress). |
| `oob.<domain>` NS to `ns1.<domain>`, `ns2.<domain>` | app zone | Delegates the OOB subdomain. interactsh is authoritative for `oob.<domain>` and every label below it, so unique per-interaction hostnames work without any wildcard record in Route53. |
| `ns1.<domain>`, `ns2.<domain>` A | app zone | Glue for the interactsh servers. Created only when `oob_server_ips` is set (INFRA-010). |
| `<domain>`, `app.<domain>`, `api.<domain>` A (alias) | app zone | Ingress load balancer. Created only when INFRA-012 passes `ingress_alias`. |
| Query log + metrics | CloudWatch Logs in `us-east-1` | Route53 delivers query logs only to `us-east-1`. Metrics `DnsQueries` and `OobDnsQueries` in `Blackwing/<prefix>/DNS`. Retention 90 days. |

Each environment has its own domain (`domain_name` in `terraform.tfvars`; `scripts/check.sh` fails if two
environments share one), so a dev OOB token cannot resolve in prod. The placeholder values in the tfvars
files must be replaced with the registered domains before the first apply.

## Manual step 1: registrar hand-off (after `tofu apply`)

The zone answers the Internet only once the registrar points at it.

1. `tofu output dns_app_name_servers` in the environment root.
2. Set exactly those four name servers as the domain's NS at the registrar.
3. Verify: `dig NS <domain> +short` returns the same four names.

Until this is done nothing under the domain resolves publicly, including the OOB delegation.

## Manual step 2: interactsh addresses (INFRA-010)

1. After INFRA-010 deploys interactsh, set `oob_server_ips` (one or two **public** IPv4 addresses) in the
   environment's `terraform.tfvars` and apply. Private, loopback and link-local addresses are rejected.
2. Verify the delegation: `dig NS oob.<domain> +short` returns `ns1.<domain>` and `ns2.<domain>`.
3. Verify the wildcard: `dig A $(openssl rand -hex 6).oob.<domain> +short` answers from interactsh.

## Rules to keep it working

- Never add a record at or below `oob.<domain>` in the app zone. A record there would shadow the delegation
  or answer instead of interactsh. The module refuses an OOB label that collides with an ingress host.
- The OOB zone is for outbound callbacks only. The egress gateway pins resolved IPs of targets (invariant
  #2) and never resolves through the OOB zone.
- The module sets `prevent_destroy` on the zone: destroying it would change the name servers and break the
  registrar delegation.
- DNS carries no secrets. Route53 changes are recorded in CloudTrail.
