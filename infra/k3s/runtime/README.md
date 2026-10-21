# Sandbox runtime (INFRA-005)

Agent sandboxes run under gVisor (`runsc`) on the `blackwing.io/pool=sandbox` node pool.

| Piece | Where |
| --- | --- |
| runsc install (pinned `RUNSC_VERSION` in `infra/versions.env`, sha512-verified) | `infra/tofu/modules/k3s/files/bw-k3s-bootstrap.sh` (`install_runsc`) |
| containerd `runsc` handler (`config-v3.toml.tmpl`, rewritten on every boot) | same script (`write_containerd_runsc`) |
| node taint `blackwing.io/sandbox=true:NoSchedule` | k3s `node-taint` in `infra/tofu/modules/k3s/main.tf` |
| `RuntimeClass gvisor` with pool scheduling | `runtimeclass.yaml` (cloud) / `../manifests/00-runtimeclass.yaml` (dev) |
| host-socket + privilege admission guard | `host-socket-guard.yaml`, `../manifests/20-admission.yaml` |
| runtime-class metric + alert | `prometheus-rules.yaml` |

## What the sandbox-controller sets on every sandbox Pod

```yaml
spec:
  runtimeClassName: gvisor # RuntimeClass scheduling merges in the selector and toleration below
  nodeSelector: { blackwing.io/pool: sandbox }
  tolerations:
    - { key: blackwing.io/sandbox, operator: Equal, value: 'true', effect: NoSchedule }
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
  containers:
    - securityContext:
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false # no-new-privileges
        capabilities: { drop: [ALL] }
```

See `../examples/sandbox-pod.yaml` for the full canonical Pod. Pods without the toleration stay
`Pending` on sandbox nodes (taint); non-sandbox workloads never land there.

## Rules

- No host-runtime fallback. If a tool needs a syscall runsc lacks, change the tool; never run
  the sandbox under runc or relax the class.
- Reboot-safe: the install and the containerd handler are re-applied by cloud-init on every boot.
- Bump `RUNSC_VERSION` and its sha512 together in `infra/versions.env` (CONTEXT_PACK §8 #9).
- Kill switch: deleting a gVisor pod with `terminationGracePeriodSeconds: 5` meets the <10s teardown target.
- Live check on a cluster with gVisor: `infra/k3s/verify.sh` (kernel is the sentry, host socket mount denied).
  This host has no gVisor, so the offline tests assert the manifests and bootstrap; the live run is tracked in #890.
