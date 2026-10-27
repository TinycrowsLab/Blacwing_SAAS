# syntax=docker/dockerfile:1
#
# Shared image recipe for the Node/TypeScript Blackwing services (CI-007 #141): api, web, worker,
# agent-runtime, model-gateway, session-manager, sandbox-controller and cli. One file keeps the
# hardening (digest-pinned base, non-root, minimal runtime) identical for every service.
# Build context: the repository root.
#   docker build -f infra/docker/service.Dockerfile --build-arg SERVICE=api -t bw-api:dev .
# The egress gateway (Go) has its own Dockerfile in apps/egress-gateway. The per-run bw-sandbox
# image is NOT built here: it is owned solely by IMAGE-012.

# Base images are pinned by digest (§8.9). Renovate bumps tag and digest together.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS deps
ARG SERVICE
RUN test -n "${SERVICE}" || { echo "SERVICE build-arg is required" >&2; exit 1; }
# No lifecycle scripts in the image build: the repo-layout preinstall hook needs the full checkout.
ENV CI=true \
    npm_config_ignore_scripts=true
WORKDIR /repo
# pnpm comes from the root package.json "packageManager" field via Corepack, never "latest".
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY scripts ./scripts
COPY apps ./apps
COPY packages ./packages
RUN corepack enable \
 && pnpm install --frozen-lockfile --filter "@blackwing/${SERVICE}..." \
 && pnpm --filter "@blackwing/${SERVICE}" run --if-present build \
 && pnpm --filter "@blackwing/${SERVICE}" deploy --prod /out

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ARG VERSION=dev
ARG COMMIT=unknown
LABEL org.opencontainers.image.title="bw-${SERVICE}" \
      org.opencontainers.image.source="https://github.com/TinycrowsLab/Blacwing_SAAS" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /out /app
# Non-root: the base image's unprivileged `node` user (uid 1000).
USER node:node
ENTRYPOINT ["node"]
CMD ["src/index.ts"]
