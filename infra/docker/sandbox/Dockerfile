# syntax=docker/dockerfile:1
#
# bw-sandbox base image (IMAGE-001 #599): the per-run, non-root, read-only-rootfs sandbox that hosts
# the agent runtime (apps/agent-runtime, Node 22) and, in later IMAGE issues, the pentest toolchain.
# Build context: the repository root (inputs are allow-listed by Dockerfile.dockerignore).
#   docker build -f infra/docker/sandbox/Dockerfile -t bw-sandbox:dev .
# Offline build: the stage uses the committed pnpm-lock.yaml (--frozen-lockfile); pre-populate a
# pnpm store and pass `--build-arg PNPM_INSTALL_FLAGS=--offline` to build without network.
# The pinned tools are linux/amd64 and linux/arm64 release assets (tools.pin.json, scanners.pin.json); production
# images are amd64.
#
# Runtime contract (SANDBOX-003/004/007): run with a read-only rootfs, /workspace and /tmp as
# writable tmpfs owned by uid 10001, all capabilities dropped. The entrypoint fails clearly (exit 78)
# when /workspace is not writable. Publishing, signing and the manifest belong to IMAGE-008/012.

# Base pinned by digest (§8.9), never a floating tag. Digest of node:22-bookworm-slim (same pin as
# infra/docker/service.Dockerfile; Renovate bumps tag and digest together). Recorded as the
# org.opencontainers.image.base.digest label so the manifest builder can read it.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
# Go toolchain for the `go` tool kind (fingerprintx). Same golang digest as apps/egress-gateway/Dockerfile.
ARG GO_IMAGE=golang:1.26.10-bookworm@sha256:ee3901c61e423732605a51f1b8157c849ec01194ea0a274213b5202b2c11e7bf
ARG PNPM_INSTALL_FLAGS=""

FROM ${NODE_IMAGE} AS builder
ARG PNPM_INSTALL_FLAGS
ENV CI=true \
    npm_config_ignore_scripts=true
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# pnpm comes from the root package.json "packageManager" field via Corepack, never "latest".
# `deploy --prod` prunes dev dependencies and the package-manager cache out of the artifact.
RUN corepack enable \
 && pnpm install --frozen-lockfile ${PNPM_INSTALL_FLAGS} --filter "@blackwing/agent-runtime..." \
 && pnpm --filter "@blackwing/agent-runtime" run --if-present build \
 && pnpm --filter "@blackwing/agent-runtime" deploy --prod /out

FROM ${GO_IMAGE} AS gotool

# ProjectDiscovery tools (IMAGE-002 #600) and pentest scanners (IMAGE-002 #601). Each pinned release asset is
# verified against its sha256 before extraction (Go tools: module zip hash); any mismatch fails the build. Only the
# verified tree is copied into the runtime stage, root-owned.
FROM ${NODE_IMAGE} AS tools
ENV GOTOOLCHAIN=local \
    PATH=/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=gotool /usr/local/go /usr/local/go
# testssl.sh needs bash, openssl, hexdump (bsdextrautils), xxd and ps (procps) to answer its version probe.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip bash openssl bsdextrautils xxd procps \
 && rm -rf /var/lib/apt/lists/*
COPY infra/docker/sandbox/tools.pin.json infra/docker/sandbox/install-tools.sh /pin/
RUN sh /pin/install-tools.sh /pin/tools.pin.json /opt/bw/tools/bin
COPY infra/docker/sandbox/scanners.pin.json infra/docker/sandbox/tools/install-tools.mjs infra/docker/sandbox/tools/bw-sqlmap.mjs /build/
RUN mkdir -p /opt/bw/tools/lib \
 && node /build/install-tools.mjs /build/scanners.pin.json /build \
 && rm -rf /tmp/bw-tools-*

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG COMMIT=unknown
ARG CREATED=unknown
ARG NODE_IMAGE
LABEL org.opencontainers.image.title="bw-sandbox" \
      org.opencontainers.image.source="https://github.com/TinycrowsLab/Blacwing_SAAS" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"

# Fixed uid/gid 10001, no login shell, no home directory on the (read-only) rootfs. python3 runs sqlmap; bash,
# openssl, hexdump (bsdextrautils), xxd and ps (procps) run testssl.sh. The tools tree stays root-owned and
# read-only so `bw` cannot replace a pinned binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash openssl bsdextrautils xxd procps python3 \
 && groupadd --system --gid 10001 bw \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /workspace --shell /usr/sbin/nologin bw \
 && mkdir -p /opt/bw/tools/bin /opt/bw/templates /opt/bw/wordlists /etc/bw /workspace /app \
 && chown -R bw:bw /opt/bw/templates /opt/bw/wordlists /etc/bw /workspace \
 && chmod 0555 /opt/bw /etc/bw \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder --chown=root:root /out /app
COPY --from=tools --chown=root:root /opt/bw/tools /opt/bw/tools
COPY --chown=root:root --chmod=0555 infra/docker/sandbox/entrypoint.sh /opt/bw/entrypoint.sh

# No secrets and no provider keys in the image: credentials arrive via the model gateway at run time.
ENV BW_SANDBOX=1 \
    NODE_ENV=production \
    HOME=/workspace \
    PATH=/opt/bw/tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace
USER bw:bw
# Healthy when the agent-runtime entry is launchable by the unprivileged user.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "await import('/app/src/index.ts')"]
ENTRYPOINT ["/opt/bw/entrypoint.sh"]
CMD ["node", "/app/src/index.ts"]
