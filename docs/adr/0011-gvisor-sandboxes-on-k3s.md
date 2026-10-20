# ADR-0011: Isolate agent sessions in gVisor sandboxes on k3s and never expose the host Docker socket

Date: 2026-10-20

## Status

Accepted

## Context

Agent sessions execute model-chosen commands and process attacker-influenced target content. A sandbox escape
would expose the platform and every other tenant. The original feature list targeted a single-node install in
the customer's own cloud; the SaaS edition is operated by Blackwing on AWS, and a portable deployment must
remain possible for a later on-prem edition.

## Decision

- Blackwing is a **Blackwing-operated SaaS on AWS EC2 running k3s**, deployed with Helm and provisioned with
  OpenTofu. The deployment stays portable for a future on-prem mode.
- Every agent session runs in **its own disposable sandbox container** (image `bw-sandbox`) under **gVisor
  (`runsc`)**: a RuntimeClass on k3s in staging and production, and a Docker plus `runsc` driver in development
  and for the future on-prem edition. Containers run non-root with a read-only root filesystem, a tmpfs
  workspace, all capabilities dropped, `no-new-privileges`, seccomp and pids, memory and CPU limits.
- **The host Docker socket (or any container-runtime socket) is never exposed to a sandbox.** Sandboxes are
  created only by `apps/sandbox-controller`.
- Each run gets its own run network. A sandbox can reach exactly three destinations: the egress gateway
  ([ADR-0008](0008-go-egress-gateway-fail-closed.md)), the model gateway and the Run Broker API. Everything else,
  including the cloud metadata endpoint and other runs, is denied.

## Consequences

- A compromised session is confined to a user-space kernel, one disposable container and one run's network,
  and it holds no real provider or target credentials.
- gVisor costs some syscall and IO performance, and some tools need adjusting to run under it; that cost is
  accepted.
- The sandbox controller abstracts the runtime behind a driver interface (KubernetesDriver, DockerDriver), which
  keeps the on-prem path open without a second sandbox design.

## References

- [Context Pack §1.1 Deliberate overrides](../architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides):
  row F41 "Single-node deployment".
- [Context Pack §4.1 Topology](../architecture/CONTEXT_PACK.md#41-topology).
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "Sandbox isolation", "Orchestration" and "IaC".
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.6 (per-run sandboxes) and §8.7 (no plaintext secrets in the sandbox).
