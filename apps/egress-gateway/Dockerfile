# syntax=docker/dockerfile:1
#
# Egress gateway container image (FOUND-013 stub).
# Build context: apps/egress-gateway, e.g.
#   docker build -t blackwing/egress-gateway:dev apps/egress-gateway
#   docker buildx build --platform linux/amd64,linux/arm64 apps/egress-gateway
# The dev stack (DEVENV) and the image pipeline (CI-007) reference this file. Base
# images are pinned by tag here; CI-007 pins them by digest and signs the result.

# Keep in sync with the `toolchain` line in go.mod.
ARG GO_VERSION=1.26.10

FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-bookworm AS build
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
    -o /out/egress-gateway .

# Static, shell-less, non-root runtime image.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/egress-gateway /egress-gateway
USER nonroot:nonroot
# No ports are exposed yet: the skeleton binds no listener (fail closed). The EGRESS
# epic adds the proxy (13128 in dev) and management (13129 in dev) listeners.
ENTRYPOINT ["/egress-gateway"]
CMD ["run"]
