# syntax=docker/dockerfile:1
#
# Egress gateway container image (FOUND-013 stub).
# Build context: apps/egress-gateway, e.g.
#   docker build -t blackwing/egress-gateway:dev apps/egress-gateway
#   docker buildx build --platform linux/amd64,linux/arm64 apps/egress-gateway
# The dev stack (DEVENV) and the image pipeline (CI-007) reference this file. Base
# images are pinned by digest (CI-007); signing is CI-010.

# Keep in sync with the `toolchain` line in go.mod.
ARG GO_VERSION=1.26.10

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm@sha256:ee3901c61e423732605a51f1b8157c849ec01194ea0a274213b5202b2c11e7bf AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
# Use exactly the image's toolchain; never download another one during the build.
ENV GOTOOLCHAIN=local \
    CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY . .
RUN GOOS="$TARGETOS" GOARCH="$TARGETARCH" \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /out/egress-gateway ./cmd/gateway

# Static, shell-less, non-root runtime image.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/egress-gateway /egress-gateway
USER nonroot:nonroot
# Management plane (health, readiness, metrics; GATEWAY_MGMT_ADDR, default :9090).
# Data-plane ports are added by the listener issues; they bind only once ready.
EXPOSE 9090
ENTRYPOINT ["/egress-gateway"]
CMD ["run"]
