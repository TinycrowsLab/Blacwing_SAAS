# Makefile for the Blackwing egress gateway (Go module, FOUND-013).
# Run from apps/egress-gateway. `make help` lists the targets.
# CI (CI-005) calls the same targets with the same .golangci.yml.

GO ?= go

# --- Toolchain pin ---------------------------------------------------------------
# go.mod is the single source of truth: `go` is the minimum language version and
# `toolchain` the exact toolchain every build uses. Exporting GOTOOLCHAIN makes the
# go command fetch and run exactly that toolchain, so local and CI builds match.
GO_MIN       := $(shell sed -n 's/^go //p' go.mod)
GO_TOOLCHAIN := $(shell sed -n 's/^toolchain //p' go.mod)
GOTOOLCHAIN  ?= $(GO_TOOLCHAIN)
export GOTOOLCHAIN

# exact   : `go version` must equal the go.mod toolchain pin (default; CI).
# minimum : only require >= the go.mod `go` line (e.g. GOTOOLCHAIN=local offline).
GO_VERSION_CHECK ?= exact

# --- Build settings --------------------------------------------------------------
# Cross-compile with e.g. `make build GOOS=linux GOARCH=arm64`.
GOOS   ?= $(shell $(GO) env GOOS)
GOARCH ?= $(shell $(GO) env GOARCH)
CROSS_PLATFORMS ?= linux/amd64 linux/arm64

VERSION ?= dev
COMMIT  ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT)

BIN_DIR := bin
OUT_DIR := $(BIN_DIR)/$(GOOS)_$(GOARCH)
BINARY  := $(OUT_DIR)/egress-gateway
COVER   := $(BIN_DIR)/coverage.out

# Build tag that compiles the pinned EGRESS libraries (internal/*/deps.go).
DEPS_TAGS := egressdeps

# Race detector needs cgo; set RACE= to disable on hosts without a C toolchain.
RACE ?= -race

# --- Pinned developer tools --------------------------------------------------------
# Installed into bin/tools/<tool>/<version>/ with `go install`; module checksums are
# verified against the Go checksum database. Tools may need a newer Go than the
# service pin to build, so they are built with TOOLS_GOTOOLCHAIN (auto-select).
GOLANGCI_LINT_VERSION ?= v2.15.0
GOSEC_VERSION         ?= v2.29.0
TOOLS_GOTOOLCHAIN     ?= auto
TOOLS_DIR := $(abspath $(BIN_DIR)/tools)
GOLANGCI_LINT_BIN := $(TOOLS_DIR)/golangci-lint/$(GOLANGCI_LINT_VERSION)/golangci-lint
GOSEC_BIN         := $(TOOLS_DIR)/gosec/$(GOSEC_VERSION)/gosec
# Override with an already-installed binary, e.g. GOLANGCI_LINT=golangci-lint; the
# pinned copy is then not installed.
GOLANGCI_LINT ?= $(GOLANGCI_LINT_BIN)
GOSEC         ?= $(GOSEC_BIN)
golangci_lint_dep := $(filter $(GOLANGCI_LINT_BIN),$(GOLANGCI_LINT))
gosec_dep         := $(filter $(GOSEC_BIN),$(GOSEC))

# Dev-only defaults for `make run`; the binary itself has no BW_ENV default.
BW_ENV    ?= dev
LOG_LEVEL ?= debug

.DEFAULT_GOAL := help

.PHONY: help
help: ## List targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: check-go
check-go: ## Verify the running Go toolchain matches the go.mod pin
	@actual="$$($(GO) env GOVERSION)"; \
	if [ -z "$(GO_TOOLCHAIN)" ] || [ -z "$(GO_MIN)" ]; then \
		echo "check-go: go.mod must declare both 'go' and 'toolchain' lines" >&2; exit 1; \
	fi; \
	case "$(GO_VERSION_CHECK)" in \
	exact) \
		if [ "$$actual" != "$(GO_TOOLCHAIN)" ]; then \
			echo "check-go: running $$actual but go.mod pins $(GO_TOOLCHAIN) (GOTOOLCHAIN=$$GOTOOLCHAIN)." >&2; \
			echo "check-go: unset GOTOOLCHAIN to use the pin, or set GO_VERSION_CHECK=minimum." >&2; \
			exit 1; \
		fi ;; \
	minimum) \
		lowest="$$(printf '%s\n%s\n' "go$(GO_MIN)" "$$actual" | sort -V | head -n 1)"; \
		if [ "$$lowest" != "go$(GO_MIN)" ]; then \
			echo "check-go: running $$actual but go.mod requires >= go$(GO_MIN)" >&2; exit 1; \
		fi ;; \
	*) echo "check-go: GO_VERSION_CHECK must be 'exact' or 'minimum'" >&2; exit 1 ;; \
	esac; \
	echo "check-go: $$actual ok ($(GO_VERSION_CHECK); pin $(GO_TOOLCHAIN), min go$(GO_MIN))"

.PHONY: build
build: check-go ## Build the binary for GOOS/GOARCH into bin/<os>_<arch>/ and compile every package
	$(GO) build ./...
	$(GO) build -tags $(DEPS_TAGS) ./...
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) \
		$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BINARY) .
	@echo "built $(BINARY)"

.PHONY: build-cross
build-cross: ## Cross-compile the container platforms (CROSS_PLATFORMS)
	@set -e; for p in $(CROSS_PLATFORMS); do \
		$(MAKE) --no-print-directory build GOOS=$${p%/*} GOARCH=$${p#*/}; \
	done

.PHONY: test
test: check-go ## Run unit tests with the race detector and coverage
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=1 $(GO) test $(RACE) -count=1 -covermode=atomic -coverprofile=$(COVER) ./...
	$(GO) test -count=1 -tags $(DEPS_TAGS) ./...

.PHONY: vet
vet: check-go ## Run go vet (with and without the dependency build tag)
	$(GO) vet ./...
	$(GO) vet -tags $(DEPS_TAGS) ./...

.PHONY: fmt
fmt: check-go $(golangci_lint_dep) ## Format sources (gofmt -s, goimports)
	"$$($(GO) env GOROOT)/bin/gofmt" -s -w .
	$(GOLANGCI_LINT) fmt ./...

.PHONY: fmt-check
fmt-check: check-go ## Fail if gofmt would change any file
	@unformatted="$$("$$($(GO) env GOROOT)/bin/gofmt" -s -l .)"; \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
	echo "fmt-check: ok"

.PHONY: lint
lint: check-go fmt-check $(golangci_lint_dep) ## Run golangci-lint (govet, staticcheck, errcheck, gosec, revive, gofmt, goimports)
	$(GOLANGCI_LINT) config verify
	$(GOLANGCI_LINT) run ./...

.PHONY: gosec
gosec: check-go $(gosec_dep) ## Run the standalone gosec scanner (including tests and tagged files)
	$(GOSEC) -quiet -tests -tags $(DEPS_TAGS) ./...

.PHONY: tidy
tidy: check-go ## go mod tidy
	$(GO) mod tidy

.PHONY: tidy-check
tidy-check: check-go ## Fail if go.mod/go.sum are not tidy
	$(GO) mod tidy -diff
	$(GO) mod verify

.PHONY: run
run: build ## Build and run the gateway locally (BW_ENV defaults to dev here only)
	BW_ENV="$(BW_ENV)" LOG_LEVEL="$(LOG_LEVEL)" ./$(BINARY) run

.PHONY: tools
tools: $(GOLANGCI_LINT_BIN) $(GOSEC_BIN) ## Install the pinned golangci-lint and gosec into bin/tools

$(GOLANGCI_LINT_BIN):
	GOTOOLCHAIN=$(TOOLS_GOTOOLCHAIN) GOBIN="$(dir $@)" \
		$(GO) install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)

$(GOSEC_BIN):
	GOTOOLCHAIN=$(TOOLS_GOTOOLCHAIN) GOBIN="$(dir $@)" \
		$(GO) install github.com/securego/gosec/v2/cmd/gosec@$(GOSEC_VERSION)

.PHONY: verify
verify: tidy-check fmt-check vet lint gosec test build build-cross ## Everything CI runs, in order

.PHONY: clean
clean: ## Remove build output (keeps installed tools)
	rm -rf $(BIN_DIR)/*_* $(COVER)
