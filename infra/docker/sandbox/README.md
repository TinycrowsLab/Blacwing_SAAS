# bw-sandbox base image (IMAGE-001, #599)

Multi-stage, non-root base for the per-run sandbox. Later IMAGE issues populate `/opt/bw/*`.

- Build (repo root as context): `docker build -f infra/docker/sandbox/Dockerfile -t bw-sandbox:dev .`
- Offline build: `--build-arg PNPM_INSTALL_FLAGS=--offline` with a pre-populated pnpm store; the lockfile is always frozen.
- arm64 builds are for dev only; production images are amd64.
- The base image is pinned by digest (`NODE_IMAGE` arg, also the `org.opencontainers.image.base.name` label).

Runtime contract (SANDBOX): user `bw` uid/gid 10001, read-only rootfs, `/workspace` and `/tmp` as tmpfs owned by
10001, all capabilities dropped. The entrypoint exits 78 with a clear message if `/workspace` is not writable and 77 if run as root.

Checks: `pnpm check:sandbox-image` (static), `pnpm test:sandbox-image` (builds and runs the image).
