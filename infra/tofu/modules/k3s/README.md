# k3s module (INFRA-004)

The Blackwing k3s cluster on EC2: one control-plane server and the `sandbox` / `egress` agent
pools. Each pool is a fixed-size Auto Scaling group over a launch template whose cloud-init installs
the pinned k3s release and joins the node by itself. gVisor RuntimeClass/taints (INFRA-005), Helm
releases (INFRA-009/010), NetworkPolicies (INFRA-011) and cert-manager (INFRA-012) are elsewhere.

## Pools

| Pool | Subnets (INFRA-002) | Size | Label | Extras |
|---|---|---|---|---|
| control-plane | private-app | exactly 1 (v1) | `blackwing.io/pool=control-plane` | k3s server, behind the internal API NLB; `AZRebalance` suspended |
| sandbox | sandbox (no internet) | `node_pools.sandbox.count` | `blackwing.io/pool=sandbox` | gVisor `runsc` + `containerd-shim-runsc-v1` installed |
| egress | private-app | `node_pools.egress.count` | `blackwing.io/pool=egress` | |

Every launch template: the security module's SG, instance profile and IMDSv2-only `metadata_options`
(hop limit 1, validated so it cannot be weakened), gp3 root volume encrypted with this module's KMS
key (rotation on; the Auto Scaling service-linked role may use it), detailed monitoring, and the
provider default tags copied onto instances and volumes.

**Single control plane.** v1 runs one server (documented single point of failure; HA is later).
Agent pools spread over every AZ. The internal NLB is cross-zone, so agents in any AZ reach it.

## Bootstrap (`files/bw-k3s-bootstrap.sh`)

cloud-init writes `/etc/blackwing/k3s-node.env` (non-secret settings), `/etc/rancher/k3s/config.yaml`
and the bootstrap script, then runs it. The script is idempotent and:

1. waits for NTP (clock skew breaks the TLS join), with exponential backoff;
2. downloads the k3s binary, the air-gap image bundle and (sandbox) the gVisor bundle, verifies the
   pinned sha256/sha512, and refuses a binary that reports another version than `k3s_version`;
3. **server**: reads the join tokens from SSM. On the very first boot the parameters hold the
   placeholder `pending`; it generates a server token and a separate agent-only token and writes
   them back (SecureString, KMS). A replacement server reuses them. Starts k3s
   (`write-kubeconfig-mode: 0600`, `tls-san: <NLB DNS>`, `disable: servicelb` (Traefik stays),
   `secrets-encryption`), waits for `/readyz`, publishes its version to `.../server-version` and the
   kubeconfig (server rewritten to the internal NLB URL) to `.../kubeconfig` (SecureString, Advanced);
4. **agent**: pre-join drift check: it joins only when `.../server-version` equals its own pinned
   `k3s_version` (retrying while the server is still booting, failing otherwise). Then it reads the
   agent-only token and starts `k3s-agent` with its pool label and kubelet reservations;
5. on exit, ships its JSON log plus the cloud-init output to the pool's CloudWatch log group,
   stream `<instance-id>/bootstrap`. Failures are also on the instance console.

There is no AWS CLI on the nodes: AWS calls use IMDSv2 credentials and `curl --aws-sigv4`, with the
credentials and tokens passed through curl's stdin config, never argv.

## Secrets

- No token is in tofu state, user-data or git. tofu creates the parameters with the placeholder and
  ignores later value changes.
- The control plane holds `ssm:GetParameter`/`PutParameter` on the four k3s parameters and uses the
  key only via SSM. Agents hold `ssm:GetParameter` on `agent-token` and `server-version` only, and
  `kms:Decrypt` only via SSM for the `agent-token` encryption context. An agent token cannot join a
  server.
- Grant `ssm:GetParameter` on `kubeconfig_parameter_arn` to the ops/CI roles that need it.

## Air-gapped sandbox nodes

The sandbox subnets have no internet route. The nodes therefore need:

- the SSM and CloudWatch Logs interface endpoints (created here, `create_interface_endpoints`);
- an artifact mirror reachable inside the VPC (`artifact_mirror_url`: an S3 bucket reached through
  the S3 gateway endpoint, laid out as `k3s/<k3s_version>/...` and
  `gvisor/<runsc_version>/x86_64/gvisor.tar.bz2`). Planning a sandbox pool without it fails;
- images: the k3s system images come from the air-gap bundle; workload images come from ECR through
  the ECR VPC endpoints (#840). Chosen path: ECR + S3 gateway endpoint, never NAT.

## Replacement

A new launch-template version (k3s version, AMI, user-data) triggers a rolling instance refresh;
each replacement bootstraps and rejoins by itself. Agent user-data carries the control-plane
launch-template version, so a new control plane (which has a new CA) also rolls the agent pools.

## Versions (§8 #9)

`k3s_version`, `k3s_sha256`, `k3s_airgap_images_sha256`, `runsc_version` and `runsc_sha512` come from
each environment's `terraform.tfvars` and must equal `infra/k3s/versions.env` / `infra/versions.env`
(`scripts/k3s-node-bootstrap.test.mjs` enforces it). The version is also a tag on every node and an
output. `ami_id` should be pinned for staging and prod; the resolved AMI is an output and a tag.

## Tests

- `tests/k3s.tftest.hcl` (mocked provider): labels, version pin, no secret in user-data, KMS gp3,
  IMDSv2, subnet placement, internal NLB, fixed sizes, instance refresh, agent IAM scope, variable
  validation.
- `scripts/k3s-node-bootstrap.test.mjs`: runs the bootstrap against fake IMDS/SSM/Logs/systemd
  (`tests/fakes/`): token generation and reuse, version drift, retries/backoff, clock skew, checksum
  mismatch, idempotency, no secret in argv or logs.
- On AWS (apply, terratest, pool smoke): deferred, see #890.
