# bw-sandbox base image (IMAGE-001, #599)

Multi-stage, non-root base for the per-run sandbox. Later IMAGE issues populate `/opt/bw/*`.

- Build (repo root as context): `docker build -f infra/docker/sandbox/Dockerfile -t bw-sandbox:dev .`
- Offline build: `--build-arg PNPM_INSTALL_FLAGS=--offline` with a pre-populated pnpm store; the lockfile is always frozen.
- arm64 builds are for dev only; production images are amd64.
- The base image is pinned by digest (`NODE_IMAGE` arg, also the `org.opencontainers.image.base.name` label).

Runtime contract (SANDBOX): user `bw` uid/gid 10001, read-only rootfs, `/workspace` and `/tmp` as tmpfs owned by
10001, all capabilities dropped. The entrypoint exits 78 with a clear message if `/workspace` is not writable and 77 if run as root.

Checks: `pnpm check:sandbox-image` (static), `pnpm test:sandbox-image` (builds and runs the image).

## Seccomp profile (SANDBOX-007)

`seccomp/bw-sandbox.json` is the default-deny seccomp profile every sandbox runs under. It allows only the
syscalls Node 22 and the toolchain need, refuses `clone3` with ENOSYS so glibc falls back to filtered `clone`,
and never allows ptrace, mount, bpf, namespace joins or io_uring. The sandbox controller's spec builder
(`apps/sandbox-controller/src/spec/hardening.ts`) references it: Kubernetes as `Localhost` `bw-sandbox.json`,
Docker as `seccomp=/etc/bw/seccomp/bw-sandbox.json`.

Distribution to nodes (the profile is never unconfined; a missing file makes create fail):

- Kubernetes: copy the file to `/var/lib/kubelet/seccomp/bw-sandbox.json` on every worker node (the kubelet
  seccomp root), by the node bootstrap in `infra/k3s`. The `Localhost` profile must exist before a sandbox pod
  is scheduled, or kubelet refuses to start it.
- Docker (dev and on-prem): install to `/etc/bw/seccomp/bw-sandbox.json` on the Docker host. The Docker driver
  must check the file exists before `createContainer` and fail closed otherwise.

The toolchain-under-profile check (running the real tools) is owned by SANDBOX-013.
