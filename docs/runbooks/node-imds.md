# Runbook: node IMDS hardening and security groups (INFRA-003)

Module: `infra/tofu/modules/security` (see its README for the rule tables).

## What protects the metadata endpoint

Security groups do not apply to `169.254.169.254`. Do not add or look for an SG rule for it. The
guarantee that a sandbox cannot read node credentials is IMDSv2-only with hop limit 1 on every node
(`module.security.metadata_options`, consumed by the launch templates in INFRA-004), plus the
sandbox NetworkPolicy from INFRA-011, plus a sandbox instance role limited to ECR pull and logs.

## Verifying on a node

On a node launched with the module's settings run
`infra/tofu/scripts/verify-imds.sh --container curlimages/curl`. Expected: host IMDSv1 returns 401,
host IMDSv2 works, a container cannot obtain a token. The cloud run of this check is tracked by the
online-porting issue "Port to online: node-role IMDS and security group integration test (from
INFRA-003)".

## If k3s or the CNI misbehaves after enabling hop limit 1

Host-network components still work with hop limit 1. If a pod needs instance metadata (for example
a cloud controller), run it with `hostNetwork: true`; never raise the hop limit.

## Changing rules

Edit the module, run `infra/tofu/scripts/check.sh modules/security`, and review `tofu plan`.
Regression tests fail if the sandbox SG gains `0.0.0.0/0` egress or any CIDR ingress.
