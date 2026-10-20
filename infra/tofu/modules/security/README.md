# security module (INFRA-003)

Least-privilege security groups, IAM roles / instance profiles and IMDS settings for the three k3s
node roles: `control-plane`, `sandbox` (gVisor) and `egress`. Launch templates (INFRA-004) consume
the outputs; Kubernetes NetworkPolicies (INFRA-011) and S3 bucket policies (INFRA-006) are separate.

## Rule sets

| SG | Ingress | Egress |
|---|---|---|
| control-plane | 6443/tcp from the sandbox and egress SGs and from itself; 2379-2380/tcp, 10250/tcp from itself; 8472/udp (VXLAN) from all node SGs; optional `lb_target_port` from `lb_security_group_id` | to itself and the agents on the same ports; 443 and 53 to the VPC CIDR only; 443 to the S3 prefix list when given |
| sandbox-node | none from any CIDR. 10250/tcp from control-plane; 8472/udp from all node SGs | 6443 to control-plane; `egress_proxy_port` (3128) to the egress SG only; 8472/udp to node SGs; 443 and 53 to the VPC CIDR; 443 to the S3 prefix list. Never `0.0.0.0/0` |
| egress-node | `egress_proxy_port` from the sandbox SG; 10250 from control-plane; 8472/udp from node SGs | all protocols to `0.0.0.0/0`: the only tier with broad egress, scoped by the gateway itself |

Everything is referenced by security group, not by CIDR, except the VPC-internal DNS / endpoint
rules. There is no public ingress anywhere; the control plane can only be reached through an LB SG.

## Metadata service: what guarantees what

Security groups **cannot** block `169.254.169.254` (link-local traffic never passes a security
group). The sandbox-to-metadata guarantee (CONTEXT_PACK §8 #2, §4.1) comes from:

1. `metadata_options` output: `http_tokens = required`, `http_put_response_hop_limit = 1`,
   `http_endpoint = enabled`. Every launch template MUST use it. The IMDSv2 token response has a
   TTL of 1 hop, so a container (one extra hop) cannot complete the handshake; the host (k3s,
   kubelet, CNI) is unaffected.
2. The NetworkPolicy that denies sandbox pods `169.254.169.254` (INFRA-011), as defence in depth
   against SSRF-style credential theft (CWE-918).
3. The sandbox instance role has no AWS permission beyond ECR pull and writing its own log group.

## IAM

- All roles: `ecr:GetAuthorizationToken` (no resource-level support, hence `*`), image pull on the
  explicit `ecr_repository_arns`, and log writes to their own `/blackwing/<prefix>/nodes/<role>`
  log group.
- control-plane only: `ssm:GetParameter(s)` on the explicit join-token ARNs (+ `kms:Decrypt` on the
  given key). Sandbox and egress nodes hold no SSM, S3, EC2 or IAM permission. How agents obtain
  the join token is decided in INFRA-004 (it must not be via the sandbox role).
- No wildcards on sensitive actions; ARN inputs reject `*`.

## Observability

SGs, roles, profiles and log groups carry a `NodeRole` tag. `enable_config_rules = true` adds the
AWS Config rules `EC2_IMDSV2_CHECK` and `INCOMING_SSH_DISABLED`; it needs a Config recorder in the
account, so it is off by default.

## Verification

Offline: `infra/tofu/scripts/check.sh modules/security` (fmt, validate, tflint, `tofu test`).
On real nodes: `infra/tofu/scripts/verify-imds.sh` (see `docs/runbooks/node-imds.md`).
