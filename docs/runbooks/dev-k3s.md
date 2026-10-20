# Dev k3s with the gVisor RuntimeClass (DEVENV-014)

The Kubernetes path for local end-to-end work: a single-node k3s on the dev host whose sandboxes run under
gVisor, matching the staging/production isolation model ([ADR-0011](../adr/0011-gvisor-sandboxes-on-k3s.md),
CONTEXT_PACK §4.1, §5). Everything lives in `infra/k3s/`:

| Path | What |
|---|---|
| `install-dev.sh` | Installs/reconciles pinned k3s, registers `runsc` with containerd, installs Helm, applies the manifests, writes the kubeconfig, runs `verify.sh`. |
| `verify.sh` | Isolation probes against the running cluster (exit 0 only if every check passed). |
| `versions.env` | k3s version + sha256, k3d image, probe image (all digest-pinned), minimum resources. runsc/kubectl/helm pins stay in `infra/versions.env`. |
| `host/` | `/etc/rancher/k3s/config.yaml`, the containerd `config-v3.toml.tmpl` (runsc handler) and the systemd unit. |
| `manifests/00-runtimeclass.yaml` | `RuntimeClass gvisor` → `handler: runsc`. |
| `manifests/10-namespaces.yaml` | `sandbox` (Pod Security `restricted`, `blackwing.io/sandbox=true`), `bw-system`, `bw-dev-outside`. |
| `manifests/20-admission.yaml` | `ValidatingAdmissionPolicy blackwing-sandbox-guard`: no hostPath (so no host socket), `runtimeClassName: gvisor`, no host namespaces, no SA token, read-only rootfs, no privilege escalation, drop ALL, CPU/memory limits. Fails closed. |
| `manifests/30-networkpolicy.yaml` | Default-deny ingress+egress in `sandbox`, then egress only to egress gateway `:13128`, model gateway `:13500`, Run Broker `:13400` in `bw-system`. No ipBlock, no DNS. |
| `manifests/40-dev-placeholders.yaml` | Dev stand-ins for those three services plus an "outside" service sandboxes must not reach. |
| `examples/sandbox-pod.yaml` | The canonical hardened sandbox Pod the sandbox-controller KubernetesDriver builds on. |
| `k3d/runtimeclass-runc.yaml` | k3d substitute only (see below). |

## Install

Prerequisites: `infra/bootstrap.sh` (DEVENV-001) has run, so `runsc` and `containerd-shim-runsc-v1` match the
pin, plus root or passwordless sudo. Minimum resources: **4 CPUs and 7.5 GiB RAM** (`K3S_MIN_CPUS`,
`K3S_MIN_MEM_MB`); the recommended dev host is in CONTEXT_PACK §10.

```bash
infra/k3s/install-dev.sh --dry-run   # what would change; no sudo, no writes
infra/k3s/install-dev.sh             # install / reconcile, then verify.sh
infra/k3s/install-dev.sh --check     # API, RuntimeClass and helm health; non-zero on failure
```

The script is idempotent. A second run changes nothing. It refuses to continue, with a remediation, when:

- the kernel lacks gVisor support (Linux < 4.14.77) or is a WSL2 kernel;
- `runsc` or its containerd shim is missing or drifted from the pin (re-run `infra/bootstrap.sh`);
- the host has fewer than the minimum resources;
- `/etc/rancher/k3s/config.yaml` sets `disable-network-policy` (the sandbox NetworkPolicy would not be enforced);
- after start, `k3s crictl info` does not list the `runsc` runtime ("runsc not registered with containerd");
- a download does not match its pinned sha256.

## kubectl context

The kubeconfig is written to `~/.kube/blackwing-dev.yaml` (mode 0600, override with `BW_K3S_KUBECONFIG`) with
the context renamed to **`bw-dev`**:

```bash
export KUBECONFIG=~/.kube/blackwing-dev.yaml
kubectl config use-context bw-dev
kubectl get runtimeclass gvisor
```

e2e suites that target Kubernetes (the sandbox-controller KubernetesDriver) read `KUBECONFIG` and the `bw-dev`
context, create sandbox Pods in the `sandbox` namespace from `examples/sandbox-pod.yaml`, and reach the
platform services in `bw-system`. Run `infra/k3s/verify.sh` before an e2e run to confirm that the isolation
properties still hold.

## What verify.sh proves

`verify.sh [--kubeconfig F] [--context C] [--k3d] [--keep]` prints one `PASS`/`FAIL` line per check and a summary:

1. Node Ready, helm present, `runtimeclass gvisor` → `runsc`, admission binding and default-deny policy present.
2. Admission (server-side dry-run): a compliant Pod is admitted. Pods that mount `/var/run/docker.sock`,
   `/run/docker.sock`, `/run/containerd/containerd.sock`, `/run/k3s/containerd/containerd.sock` or `/` via hostPath
   are **rejected**, and so are Pods without `runtimeClassName: gvisor`, with `hostNetwork`, running as root, or
   with a writable rootfs.
3. The sample sandbox Pod starts. `dmesg` inside it shows the gVisor kernel, and `uname -a` is printed.
4. Inside the Pod: uid 65532, the rootfs is read-only, `CapEff` is all zero, `NoNewPrivs`, `/workspace` is a
   writable tmpfs and no SA token is mounted. The spec also has seccomp `RuntimeDefault` and limits.
5. Egress: the three allowed services answer. These are **blocked**: `169.254.169.254`, `[fd00:ec2::254]`
   (IPv6 metadata), `1.1.1.1`, `[2606:4700:4700::1111]`, the `outside-http` service, the Kubernetes API, the node's
   kubelet and the node's Docker port. A **control** Pod in `bw-dev-outside` reaches `outside-http`, which shows
   that the block comes from the policy and not from a broken network.
6. No container-runtime socket exists anywhere under `/run` or `/var/run` inside the sandbox.

The pids limit is node-wide (`kubelet-arg: pod-max-pids=512` in `host/config.yaml`), because Kubernetes has no
per-pod pids field.

## NetworkPolicy enforcement and drops

k3s enforces NetworkPolicy with its embedded kube-router controller on top of flannel. Never pass
`--disable-network-policy`. If a CNI without policy support were in use, the policy objects would be accepted but
not enforced. `verify.sh` catches that, because the "egress blocked" checks then FAIL. To inspect drops on the node:

```bash
sudo iptables -L -n -v | grep -A5 KUBE-NWPLCY      # per-policy chains and packet counters
sudo iptables -L KUBE-NWPLCY-DEFAULT -n -v          # default-deny counters
sudo journalctl -u k3s | grep -i netpol            # controller sync errors
kubectl -n sandbox describe networkpolicy
```

k3s and pod logs come from `journalctl -u k3s` and `kubectl logs`. With the compose `obs` profile running, point
an OTel collector or promtail at them. The cluster is for dev only and is never exposed publicly.

## Skipping the k3s path

On small laptops, or anywhere gVisor + k3s is not possible, set `BW_K3S_SKIP=1`. `install-dev.sh` then exits 0
and local sandboxes use the Docker + `runsc` driver (DockerDriver).

### k3d substitute (hosts without gVisor, e.g. WSL2)

`install-dev.sh --k3d` runs the same k3s version inside Docker via k3d (`k3d` and `crane` in `~/.local/bin`). No
root is needed. Images are preloaded from the host with their digests intact, and helm is installed per user. The
only difference from the real path is `k3d/runtimeclass-runc.yaml`: `gvisor` maps to `runc`. `verify.sh --k3d`
then reports the two gVisor checks as **NOT VERIFIED**, never as passed. Every admission, hardening, egress and
socket check still has to pass. The real gVisor proof on an Ubuntu 24.04 host is tracked in online-porting
issue #886. Remove the cluster with `k3d cluster delete bw-dev`.

## Tests

- `node --test scripts/k3s-dev.test.mjs` (part of `pnpm test:scripts`): parses every manifest and asserts the
  contract (RuntimeClass, PSA, admission rules, the exact three egress rules, the Pod hardening), runs
  `kubeconform -strict`, runs `shellcheck`, and runs `install-dev.sh` against a mocked host for every edge case
  (old or WSL kernel, missing or drifted runsc, runsc not registered, NetworkPolicy disabled, low resources,
  skip, checksum mismatch, dry-run, idempotence). It also checks that `verify.sh` FAILs on a cluster that
  enforces nothing.
- Integration: `infra/k3s/install-dev.sh` (or `--k3d`), which ends with `verify.sh`.
