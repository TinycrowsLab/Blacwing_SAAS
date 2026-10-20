# modules/vpc: Blackwing network backbone (INFRA-002, #37)

One VPC per environment with three subnet tiers in every AZ, static egress IPs and VPC Flow Logs.
It is the network layer of the egress fail-closed guarantee (CONTEXT_PACK §8 #2, §4.1).

| Tier | Route table | Holds |
|---|---|---|
| `public` | `0.0.0.0/0` to the Internet Gateway | NAT gateway(s), Traefik load balancer |
| `private-app` | `0.0.0.0/0` to the NAT gateway (one table per AZ) | app nodes: OS/package pulls, SES, model providers |
| `sandbox` | **no routes besides the implicit local VPC route**, plus a NACL that only allows the VPC CIDR | sandbox nodes |

Sandbox traffic can only leave through the egress gateway (`apps/egress-gateway`) inside the VPC.
NetworkPolicy (INFRA-011) pins sandbox pods to it, and security groups (INFRA-003) add the
metadata/private-range blocks. **Never add an IGW or NAT route to the sandbox route table.** The
table is declared with `route = []`, so OpenTofu owns its routes exclusively: a route added out of
band is removed on the next apply. `tests/vpc.tftest.hcl` fails if a default route appears.

No subnet auto-assigns public IPs. The default security group of the VPC is managed with no rules.

## Inputs

| Name | Default | Notes |
|---|---|---|
| `name_prefix` | (required) | e.g. `blackwing-dev`; used in every `Name` tag |
| `environment` | (required) | `dev`, `staging` or `prod` |
| `cidr_block` | `10.40.0.0/16` | RFC 1918, `/16` to `/24`, network address only |
| `az_count` | `2` | 2 to 4 |
| `availability_zones` | `[]` | empty means the region's available AZs, sorted by name |
| `single_nat` | `null` | `null` = `true` outside prod, `false` in prod. `true` in prod is **rejected** at plan time |
| `eip_quota` | `5` | Elastic IPs the NATs may use; plan fails clearly above it |
| `flow_log_destination` | `cloud-watch-logs` | or `s3` with `flow_log_s3_bucket_arn` |
| `flow_log_retention_days` | `365` | CloudWatch log group retention |
| `flow_log_kms_key_arn` | `null` | optional CMK for the log group |

Outputs: `vpc_id`, `vpc_cidr_block`, `availability_zones`, `subnet_ids` and `subnet_cidrs` (maps by
tier), `route_table_ids` (map by tier), `nat_gateway_ids`, `egress_ips`,
`egress_eip_allocation_ids`, `single_nat`, `flow_log_id`.

## Address plan

Each subnet is 1/16 of `cidr_block` (a `/20` of a `/16`). Indices 0-3 are public, 4-7 private-app,
8-11 sandbox and 12-15 spare, so the tiers never overlap for any `az_count` up to 4. For
`10.40.0.0/16`: public `10.40.0.0/20`, `10.40.16.0/20`; private-app `10.40.64.0/20`,
`10.40.80.0/20`; sandbox `10.40.128.0/20`, `10.40.144.0/20`.

**Choosing a CIDR.** The range must not overlap any network that will ever be peered, attached by
VPN or Transit Gateway, or that the egress gateway must route to on a customer's behalf. Overlap
cannot be fixed later without rebuilding the VPC. The environments use `10.40/16` (dev),
`10.41/16` (staging) and `10.42/16` (prod). Pick another range in the same way for new
environments and record it in `terraform.tfvars`.

## Egress IPs

Every NAT gateway gets its own `aws_eip` (`Role = customer-egress`). `egress_ips` is exactly that
set, the list customers allowlist (published by INFRA-015). The EIPs are separate resources, so a
NAT gateway that is replaced keeps its address. In prod there is one NAT per AZ with a distinct EIP,
so an AZ outage only takes that AZ's NAT down and the remaining egress IPs stay unchanged.

**EIP quota.** AWS allows 5 Elastic IPs per region per account by default (Service Quotas, EC2,
"EC2-VPC Elastic IPs"). The NATs need 1 (`single_nat`) or `az_count` EIPs, plus whatever else the
account uses. Request an increase first, then raise `eip_quota`. The plan fails with a clear
message when the NATs need more than `eip_quota`.

## Flow Logs

One flow log on the VPC covers every ENI in every tier, with `traffic_type = ALL` (ACCEPT and
REJECT). The custom format includes `action`, `srcaddr`, `dstaddr`, `bytes`, `subnet-id`,
`flow-direction` and the packet-level addresses. CloudWatch delivery uses a role that may only write
to this module's log group.

## Tests

`tests/vpc.tftest.hcl` runs offline with the mocked AWS provider (`infra/tofu/scripts/check.sh`).
It covers tiers per AZ, the sandbox route table having no routes, NAT and IGW routing,
`egress_ips` matching the EIPs, flow logs, prod per-AZ NAT, single-NAT rejection in prod, EIP
quota, too few AZs, and CIDR validation.

The live checks (apply, then curl from a sandbox-subnet instance fails while a private-app
instance reaches the internet through a NAT EIP) need an AWS account. They are tracked in #887.
