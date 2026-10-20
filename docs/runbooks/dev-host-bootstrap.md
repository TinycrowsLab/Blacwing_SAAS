# Dev-host bootstrap

`infra/bootstrap.sh` turns a fresh **Ubuntu 24.04 LTS** host (AWS EC2 dev instance, laptop or VM; see
[CONTEXT_PACK §10](../architecture/CONTEXT_PACK.md#10-development-environment--workflow)) into a Blackwing dev
machine. It installs, at the exact versions pinned in [`infra/versions.env`](../../infra/versions.env):

| Tool | Source | Verification |
|---|---|---|
| Docker Engine, CLI, containerd, buildx, compose plugin | Docker apt repo (`noble stable`), packages held with `apt-mark hold` | apt repo signature; signing-key fingerprint pinned as `DOCKER_GPG_FINGERPRINT` |
| gVisor `runsc` + `containerd-shim-runsc-v1` | gVisor release bundle `gvisor.tar.bz2` | `RUNSC_SHA512_<ARCH>` |
| Node.js 22 | nodejs.org tarball | `NODE_SHA256_<ARCH>` |
| pnpm | corepack (bundled with Node 22), `pnpm@PNPM_VERSION` | corepack's npm-registry signature check |
| Go | go.dev tarball | `GO_SHA256_<ARCH>` |
| OpenTofu, kubectl, helm, mkcert, jq | upstream release binaries | `*_SHA256_<ARCH>` |

Binaries land in `/usr/local/lib/blackwing/<tool>/<version>/` and are linked from `/usr/local/bin`. `runsc` is
registered as a Docker runtime in `/etc/docker/daemon.json` (other keys are preserved). k3s and the gVisor
RuntimeClass are DEVENV-014. The compose dev stack starts with DEVENV-002.

## Run it

```bash
infra/bootstrap.sh --dry-run   # what would change; needs no sudo, changes nothing
infra/bootstrap.sh             # install / reconcile (normal user with sudo rights, or root)
newgrp docker                  # or log out and in, if the script says the group is not active yet
infra/bootstrap.sh --check     # expected vs actual table; exits non-zero on any drift
```

The script is idempotent. Each step reads the installed version first and acts only when a tool is missing or
mismatched. A second run reports `bootstrap complete: 0 change(s)` and exits 0. A half-finished earlier install (no
`.complete` marker in the versioned directory, a missing link, a Docker package at another version) is repaired
tool by tool.

Both `install` and `--check` end with a version table and write `infra/.bootstrap-report.json` (git-ignored). The
table covers the Docker packages, every tool, the `runsc` runtime registration, running containers that mount a
Docker/containerd socket (must be `none`) and `docker run --rm --runtime=runsc --network=none hello-world@<digest>`.

## Failure modes

| Symptom | Meaning / fix |
|---|---|
| `Required privileges ...` then `sudo is not installed` or `no terminal is attached` | Run as a user with sudo rights from an interactive shell, or run `sudo -v` first. |
| `unsupported CPU architecture` | Only x86_64 and aarch64 are supported. |
| `unsupported OS` | Only Ubuntu 24.04 LTS is supported. |
| `download failed after N attempts` | Network trouble. Downloads retry with exponential backoff (`BW_BOOTSTRAP_RETRIES`, default 5). |
| `checksum mismatch` / `no pinned ... checksum` | The artifact does not match `versions.env`, so it is discarded. Never edit a checksum without taking it from the upstream release's checksum file. |
| `docker apt signing key fingerprint ... does not match` | The fetched Docker key is not the pinned one, so the repo is not trusted. |
| `kernel ... is too old for gVisor` or WSL2 warning | gVisor needs Linux >= 4.14.77. Install `linux-generic-hwe-24.04` and reboot, or use the EC2 dev host. |
| `runsc hello-world ... failed` | Check `runsc --version`, `/etc/docker/daemon.json` and `systemctl status docker`, and that the kernel supports gVisor. |
| `docker.sock mounts ... DRIFT` | A running container has the Docker socket mounted. That breaks [§4.1](../architecture/CONTEXT_PACK.md#41-topology): stop it. |

## Bumping a version

Edit `infra/versions.env` and update the version and its checksums for **both** arches in the same commit, taking
them from the upstream checksum file (`SHA256SUMS`, `*.sha256sum`, `*.sha512`; mkcert publishes none, so compute and
review it). `PNPM_VERSION` must equal `packageManager` in the root `package.json`. `GO_VERSION` must equal the
`toolchain` line of `apps/egress-gateway/go.mod`. `scripts/infra-bootstrap.test.mjs` enforces both rules.

## Tests

`node --test scripts/infra-bootstrap.test.mjs` (part of `pnpm test:scripts`) runs shellcheck and then runs the
script against a simulated host. Mocked `sudo`/apt/dpkg/systemctl/docker/curl and local fixture downloads cover the
fresh install, idempotent re-run, `--check` drift, partial installs, no sudo, ARM, retries, checksum and key
failures, the docker-group notice, old kernels, a failing runsc check and socket exposure. A real run on a
disposable Ubuntu 24.04 VM or EC2 instance is the manual integration check: run the script, then `--check`.
